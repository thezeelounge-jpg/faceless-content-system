// Runs our real migration on an in-memory Postgres (PGlite) with small stand-ins
// for Supabase's auth schema and roles, then proves the access rules work:
// user A can never see user B's data, and customers can't write anything.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every migration, in file-name order, exactly as `supabase db push` runs them.
const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));

// Minimal stand-ins for what Supabase provides in every project.
const SUPABASE_STUBS = `
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    allowed_mime_types text[]
  );
`;

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const BRAND_A = "10000000-0000-0000-0000-00000000000a";
const BRAND_B = "10000000-0000-0000-0000-00000000000b";
const POST_A = "20000000-0000-0000-0000-00000000000a";
const POST_B = "20000000-0000-0000-0000-00000000000b";

let db: PGlite;

async function asRole<T>(role: "authenticated" | "anon" | "service_role", userId: string | null, fn: () => Promise<T>) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

const asUser = <T>(userId: string, fn: () => Promise<T>) => asRole("authenticated", userId, fn);

async function names(sql: string): Promise<string[]> {
  const result = await db.query<{ name: string }>(sql);
  return result.rows.map((row) => row.name).sort();
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SUPABASE_STUBS);
  for (const migration of MIGRATIONS) await db.exec(migration);

  // Two sign-ups, each with a brand, a post, a script and an internal QA report.
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${USER_A}', 'a@example.com', '{"full_name": "User A"}'),
      ('${USER_B}', 'b@example.com', '{}');
    insert into public.brands (id, owner_id, name) values
      ('${BRAND_A}', '${USER_A}', 'Brand A'),
      ('${BRAND_B}', '${USER_B}', 'Brand B');
    insert into public.posts (id, brand_id, scheduled_for, title) values
      ('${POST_A}', '${BRAND_A}', now(), 'Post A'),
      ('${POST_B}', '${BRAND_B}', now(), 'Post B');
    insert into public.scripts (post_id, display_text) values
      ('${POST_A}', 'Script A'),
      ('${POST_B}', 'Script B');
    insert into public.qa_reports (script_id, gate, passed)
      select id, 'script', true from public.scripts;
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("database setup", () => {
  it("creates a profile automatically on sign-up", async () => {
    const result = await db.query<{ id: string; email: string; full_name: string | null; role: string }>(
      "select id, email, full_name, role from public.profiles order by email",
    );
    expect(result.rows).toEqual([
      { id: USER_A, email: "a@example.com", full_name: "User A", role: "customer" },
      { id: USER_B, email: "b@example.com", full_name: null, role: "customer" },
    ]);
  });

  it("seeds the safety settings", async () => {
    const result = await db.query<{ key: string }>("select key from public.app_settings order by key");
    expect(result.rows.map((row) => row.key)).toEqual(["daily_spend_cap_usd", "ramadan", "renders_paused"]);
  });

  it("stores tiny Claude costs exactly (ai_usage.cost_usd has 6 decimals)", async () => {
    const column = await db.query<{ numeric_precision: number; numeric_scale: number }>(
      `select numeric_precision, numeric_scale from information_schema.columns
       where table_schema = 'public' and table_name = 'ai_usage' and column_name = 'cost_usd'`,
    );
    expect(column.rows[0]).toEqual({ numeric_precision: 12, numeric_scale: 6 });
    const saved = await db.query<{ cost: string }>(
      `insert into public.ai_usage (task, model, cost_usd) values ('test', 'claude-haiku-5-5', 0.000123)
       returning cost_usd::text as cost`,
    );
    expect(saved.rows[0].cost).toBe("0.000123");
    await db.exec(`delete from public.ai_usage where task = 'test'`);
  });

  it("rejects values outside the allowed lists", async () => {
    await expect(
      db.exec(`insert into public.brands (owner_id, name, posts_per_week) values ('${USER_A}', 'Bad', 20)`),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("customers only see their own rows", () => {
  it("user A sees only user A's profile, brand, post and script", async () => {
    await asUser(USER_A, async () => {
      const profiles = await db.query<{ email: string }>("select email from public.profiles");
      expect(profiles.rows).toEqual([{ email: "a@example.com" }]);
      expect(await names("select name from public.brands")).toEqual(["Brand A"]);
      expect(await names("select title as name from public.posts")).toEqual(["Post A"]);
      expect(await names("select display_text as name from public.scripts")).toEqual(["Script A"]);
    });
  });

  it("user B sees only user B's brand", async () => {
    await asUser(USER_B, async () => {
      expect(await names("select name from public.brands")).toEqual(["Brand B"]);
    });
  });

  it("customers cannot insert, update or delete anything", async () => {
    await asUser(USER_A, async () => {
      await expect(
        db.exec(`insert into public.brands (owner_id, name) values ('${USER_A}', 'Sneaky')`),
      ).rejects.toThrow(/permission denied/);
      await expect(db.exec(`update public.profiles set role = 'admin'`)).rejects.toThrow(/permission denied/);
      await expect(db.exec(`delete from public.posts`)).rejects.toThrow(/permission denied/);
    });
  });

  it("customers cannot read internal tables", async () => {
    await asUser(USER_A, async () => {
      for (const table of ["qa_reports", "webhook_events", "ai_usage", "provider_usage", "app_settings"]) {
        await expect(db.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      }
    });
  });

  it("logged-out visitors cannot read anything", async () => {
    await asRole("anon", null, async () => {
      await expect(db.query("select * from public.profiles")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from public.brands")).rejects.toThrow(/permission denied/);
    });
  });

  it("server code (secret key) sees everything", async () => {
    await asRole("service_role", null, async () => {
      expect(await names("select name from public.brands")).toEqual(["Brand A", "Brand B"]);
      const reports = await db.query("select * from public.qa_reports");
      expect(reports.rows).toHaveLength(2);
    });
  });
});

// One row per user in every customer-readable table, labelled "A" or "B".
// Each test proves A sees only A's row, B only B's, and anon nothing.
const OWNED_TABLES: { table: string; label: string }[] = [
  { table: "consents", label: "person_legal_name" },
  { table: "avatars", label: "heygen_group_id" },
  { table: "pronunciations", label: "written" },
  { table: "videos", label: "heygen_video_id" },
  { table: "usage_ledger", label: "note" },
  { table: "subscriptions", label: "external_id" },
  { table: "manual_payments", label: "reference" },
];

describe("isolation for consents, twins, names, videos, usage and payments", () => {
  beforeAll(async () => {
    for (const [user, brand, tag] of [
      [USER_A, BRAND_A, "A"],
      [USER_B, BRAND_B, "B"],
    ]) {
      await db.exec(`
        insert into public.consents (brand_id, person_legal_name, checkbox_at, words, words_expire_at)
          values ('${brand}', 'Consent ${tag}', now(), '{one,two}', now() + interval '1 day');
        insert into public.avatars (brand_id, heygen_group_id) values ('${brand}', 'Avatar ${tag}');
        insert into public.pronunciations (brand_id, written, say_as) values ('${brand}', 'Name ${tag}', 'naym');
        insert into public.videos (brand_id, heygen_video_id) values ('${brand}', 'Video ${tag}');
        insert into public.usage_ledger (owner_id, period_start, delta, reason, note)
          values ('${user}', now(), 1, 'reserve', 'Ledger ${tag}');
        insert into public.subscriptions (owner_id, provider, external_id, plan, status)
          values ('${user}', 'manual', 'Sub ${tag}', 'creator', 'active');
        insert into public.manual_payments (owner_id, method, reference, amount, plan, period_start, period_end)
          values ('${user}', 'bank', 'Payment ${tag}', 1000, 'creator', now(), now() + interval '30 days');
      `);
    }
  });

  for (const { table, label } of OWNED_TABLES) {
    it(`${table}: user A sees only A's row, user B only B's`, async () => {
      const sql = `select ${label} as name from public.${table}`;
      await asRole("service_role", null, async () => {
        expect((await names(sql)).map((n) => n.split(" ")[1])).toEqual(["A", "B"]);
      });
      await asUser(USER_A, async () => {
        expect((await names(sql)).map((n) => n.split(" ")[1])).toEqual(["A"]);
      });
      await asUser(USER_B, async () => {
        expect((await names(sql)).map((n) => n.split(" ")[1])).toEqual(["B"]);
      });
    });

    it(`${table}: logged-out visitors read nothing`, async () => {
      await asRole("anon", null, async () => {
        await expect(db.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      });
    });

    it(`${table}: customers cannot write`, async () => {
      await asUser(USER_A, async () => {
        await expect(db.exec(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
        await expect(db.exec(`update public.${table} set ${label} = 'x'`)).rejects.toThrow(/permission denied/);
      });
    });
  }

  // Storage: PGlite has no real Supabase storage schema, so the test setup
  // stubs only storage.buckets. Storage *policies* (on storage.objects) can't
  // be tested here. Our migration adds no storage policies on purpose (server
  // code with the secret key only), so we check the buckets are private.
  it("storage buckets from our migration are private", async () => {
    const buckets = await db.query<{ id: string; public: boolean }>("select id, public from storage.buckets order by id");
    expect(buckets.rows).toEqual([
      { id: "assets", public: false },
      { id: "consent-clips", public: false },
      { id: "videos", public: false },
    ]);
  });
});

// Phase 3: emails are never sent yet. The consent link and reshoot tips are
// written to email_outbox (server only), so nothing reaches a real inbox.
describe("email_outbox (mocked emails, Phase 3)", () => {
  it("server code can store a mocked email; status is always 'mocked'", async () => {
    await asRole("service_role", null, async () => {
      const saved = await db.query<{ status: string; kind: string }>(
        `insert into public.email_outbox (brand_id, to_email, kind, subject, body)
         values ('${BRAND_A}', 'a@example.com', 'consent_link', 'Confirm', 'Link') returning status, kind`,
      );
      expect(saved.rows).toEqual([{ status: "mocked", kind: "consent_link" }]);
      await expect(
        db.exec(`insert into public.email_outbox (to_email, kind, subject, body, status)
                 values ('a@example.com', 'consent_link', 's', 'b', 'sent')`),
      ).rejects.toThrow(/check constraint/);
      await expect(
        db.exec(`insert into public.email_outbox (to_email, kind, subject, body)
                 values ('a@example.com', 'newsletter', 's', 'b')`),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it("customers and logged-out visitors cannot read or write it", async () => {
    await asUser(USER_A, async () => {
      await expect(db.query("select * from public.email_outbox")).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`insert into public.email_outbox (to_email, kind, subject, body) values ('x@y.z', 'consent_link', 's', 'b')`),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole("anon", null, async () => {
      await expect(db.query("select * from public.email_outbox")).rejects.toThrow(/permission denied/);
    });
  });

  it("RLS is on for email_outbox", async () => {
    const result = await db.query<{ on: boolean }>(
      "select relrowsecurity as on from pg_class where oid = 'public.email_outbox'::regclass",
    );
    expect(result.rows).toEqual([{ on: true }]);
  });
});

describe("avatars (Phase 3 twin creation)", () => {
  it("one twin per consent: a second avatar for the same consent is refused", async () => {
    await asRole("service_role", null, async () => {
      const consent = await db.query<{ id: string }>(
        `insert into public.consents (brand_id, person_legal_name, checkbox_at, words, words_expire_at)
         values ('${BRAND_A}', 'Twin Test', now(), '{a,b,c}', now() + interval '30 minutes') returning id`,
      );
      const id = consent.rows[0].id;
      await db.exec(`insert into public.avatars (brand_id, consent_id) values ('${BRAND_A}', '${id}')`);
      await expect(
        db.exec(`insert into public.avatars (brand_id, consent_id) values ('${BRAND_A}', '${id}')`),
      ).rejects.toThrow(/duplicate key/);
      const saved = await db.query<{ error: string | null }>(
        `update public.avatars set error = 'HeyGen said no' where consent_id = '${id}' returning error`,
      );
      expect(saved.rows).toEqual([{ error: "HeyGen said no" }]);
      await db.exec(`delete from public.avatars where consent_id = '${id}'; delete from public.consents where id = '${id}';`);
    });
  });

  it("SF2 claim: only the first 'about to create the twin' update wins", async () => {
    await asRole("service_role", null, async () => {
      const avatar = await db.query<{ id: string }>(
        `insert into public.avatars (brand_id) values ('${BRAND_A}') returning id`,
      );
      const id = avatar.rows[0].id;
      const claim = `update public.avatars set create_started_at = now()
                     where id = $1 and heygen_group_id is null and create_started_at is null returning id`;
      expect((await db.query(claim, [id])).rows).toHaveLength(1);
      expect((await db.query(claim, [id])).rows).toHaveLength(0);
      await db.exec(`delete from public.avatars where id = '${id}'`);
    });
  });
});

// Privilege guard over EVERY table in the public schema, read from pg_tables
// (so a new table is covered automatically). Customers (authenticated) may only
// SELECT; anon gets nothing. This catches a stray GRANT even if a default-deny
// RLS policy would hide it (an UPDATE that silently changes 0 rows).
describe("table privileges for anon and authenticated", () => {
  // Allow-list: internal tables. Customers cannot even read these; only server
  // code (service_role) uses them. Any other public table must be customer-readable.
  const INTERNAL_TABLES = ["ai_usage", "app_settings", "email_outbox", "provider_usage", "qa_reports", "webhook_events"];
  const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;

  async function publicTables(): Promise<string[]> {
    return names("select tablename as name from pg_tables where schemaname = 'public'");
  }

  async function granted(role: "anon" | "authenticated", table: string): Promise<string[]> {
    const held: string[] = [];
    for (const privilege of PRIVILEGES) {
      const result = await db.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [
        role,
        `public.${table}`,
        privilege,
      ]);
      if (result.rows[0].ok) held.push(privilege);
    }
    return held;
  }

  it("finds the tables (customer-readable ones include scripts and brand_versions)", async () => {
    const tables = await publicTables();
    const readable = tables.filter((t) => !INTERNAL_TABLES.includes(t));
    expect(readable).toContain("scripts");
    expect(readable).toContain("brand_versions");
    // Every allow-listed internal table really exists (no stale names).
    expect(tables).toEqual(expect.arrayContaining(INTERNAL_TABLES));
    expect(readable.length).toBeGreaterThanOrEqual(12);
  });

  it("authenticated has SELECT only on every customer table, nothing on internal ones", async () => {
    const seen: Record<string, string[]> = {};
    for (const table of await publicTables()) seen[table] = await granted("authenticated", table);
    const expected = Object.fromEntries(
      Object.keys(seen).map((t) => [t, INTERNAL_TABLES.includes(t) ? [] : ["SELECT"]]),
    );
    expect(seen).toEqual(expected);
    expect(seen.scripts).toEqual(["SELECT"]);
    expect(seen.brand_versions).toEqual(["SELECT"]);
  });

  it("anon has no SELECT, INSERT, UPDATE, DELETE or TRUNCATE on any table", async () => {
    const seen: Record<string, string[]> = {};
    for (const table of await publicTables()) seen[table] = await granted("anon", table);
    const expected = Object.fromEntries(Object.keys(seen).map((t) => [t, []]));
    expect(seen).toEqual(expected);
    expect(seen.scripts).toEqual([]);
    expect(seen.brand_versions).toEqual([]);
  });
});

const PILLARS = JSON.stringify([
  { name: "One", description: "First pillar of four." },
  { name: "Two", description: "Second pillar of four." },
  { name: "Three", description: "Third pillar of four." },
  { name: "Four", description: "Fourth pillar of four." },
]);

describe("brand profile versions (save_brand_version)", () => {
  const save = (brandId: string, profile: string, pillars = PILLARS, source = "generated") =>
    db.query<{ version: number }>(`select public.save_brand_version($1, $2, $3::jsonb, $4) as version`, [
      brandId,
      profile,
      pillars,
      source,
    ]);

  it("saves version 1, then version 2 on the next edit, and updates the brand", async () => {
    await asRole("service_role", null, async () => {
      expect((await save(BRAND_A, "Profile v1")).rows[0].version).toBe(1);
      expect((await save(BRAND_A, "Profile v2", PILLARS, "edited")).rows[0].version).toBe(2);
      const brand = await db.query<{ current_version: number; profile_md: string; pillars: unknown[] }>(
        `select current_version, profile_md, pillars from public.brands where id = $1`,
        [BRAND_A],
      );
      expect(brand.rows[0]).toMatchObject({ current_version: 2, profile_md: "Profile v2" });
      expect(brand.rows[0].pillars).toHaveLength(4);
      const versions = await db.query<{ version: number; source: string; profile_md: string }>(
        `select version, source, profile_md from public.brand_versions where brand_id = $1 order by version`,
        [BRAND_A],
      );
      expect(versions.rows).toEqual([
        { version: 1, source: "generated", profile_md: "Profile v1" },
        { version: 2, source: "edited", profile_md: "Profile v2" },
      ]);
    });
  });

  it("rejects fewer than 4 or more than 6 pillars, an unknown source, or a missing brand", async () => {
    await asRole("service_role", null, async () => {
      const three = JSON.stringify(JSON.parse(PILLARS).slice(0, 3));
      await expect(save(BRAND_A, "x", three)).rejects.toThrow(/4 to 6 pillars/);
      await expect(save(BRAND_A, "x", PILLARS, "magic")).rejects.toThrow();
      await expect(save("10000000-0000-0000-0000-0000000000ff", "x")).rejects.toThrow(/not found/);
      const brand = await db.query<{ current_version: number }>(
        `select current_version from public.brands where id = $1`,
        [BRAND_A],
      );
      expect(brand.rows[0].current_version).toBe(2);
    });
  });

  it("customers cannot call it", async () => {
    await asUser(USER_A, async () => {
      await expect(save(BRAND_A, "Sneaky")).rejects.toThrow(/permission denied/);
    });
  });

  it("logged-out visitors (anon) cannot call it", async () => {
    await asRole("anon", null, async () => {
      await expect(save(BRAND_A, "Sneaky")).rejects.toThrow(/permission denied/);
    });
    const brand = await db.query<{ profile_md: string }>(`select profile_md from public.brands where id = $1`, [BRAND_A]);
    expect(brand.rows[0].profile_md).not.toBe("Sneaky");
  });

  it("customers read only their own versions", async () => {
    await asRole("service_role", null, () => save(BRAND_B, "Profile B"));
    await asUser(USER_A, async () => {
      const rows = await db.query<{ brand_id: string }>("select brand_id from public.brand_versions");
      expect(rows.rows.length).toBe(2);
      expect(rows.rows.every((row) => row.brand_id === BRAND_A)).toBe(true);
    });
  });
});
