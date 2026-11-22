// Runs our real migration on an in-memory Postgres (PGlite) with small stand-ins
// for Supabase's auth schema and roles, then proves the access rules work:
// user A can never see user B's data, and customers can't write anything.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RENDER, TWIN_POLL_MAX_S } from "@/lib/qa/config";

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
    file_size_limit bigint,
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
    expect(result.rows.map((row) => row.key)).toEqual(["daily_spend_cap_usd", "heygen_daily_caps", "ramadan", "renders_paused"]);
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
// `read` (optional): what a customer may select to tell the rows apart, when
// the label column itself is server only (videos, SF2).
const OWNED_TABLES: { table: string; label: string; read?: string }[] = [
  { table: "consents", label: "person_legal_name" },
  { table: "avatars", label: "heygen_group_id" },
  { table: "pronunciations", label: "written" },
  {
    table: "videos",
    label: "heygen_video_id",
    read: `case brand_id when '${BRAND_A}' then 'Video A' when '${BRAND_B}' then 'Video B' end`,
  },
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

  for (const { table, label, read } of OWNED_TABLES) {
    it(`${table}: user A sees only A's row, user B only B's`, async () => {
      const sql = `select ${read ?? label} as name from public.${table}`;
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

  it("decision 4: consent-clips accepts files up to 50 MB (52428800 bytes)", async () => {
    const bucket = await db.query<{ limit: string }>(
      "select file_size_limit::text as limit from storage.buckets where id = 'consent-clips'",
    );
    expect(bucket.rows).toEqual([{ limit: "52428800" }]);
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

  it("decision 6: brands.contact_email holds an email or nothing; customers still cannot write it", async () => {
    await asRole("service_role", null, async () => {
      await db.query("update public.brands set contact_email = 'client@clinic.example' where id = $1", [BRAND_A]);
      await expect(db.query("update public.brands set contact_email = 'nope' where id = $1", [BRAND_A])).rejects.toThrow(
        /check constraint/,
      );
      await db.query("update public.brands set contact_email = null where id = $1", [BRAND_A]);
    });
    await asUser(USER_A, async () => {
      await expect(
        db.query("update public.brands set contact_email = 'x@y.example' where id = $1", [BRAND_A]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("decision 2: consents.clip_check_status takes only pending/running/done/failed", async () => {
    await asRole("service_role", null, async () => {
      const consent = await db.query<{ id: string; status: string | null }>(
        `insert into public.consents (brand_id, person_legal_name, checkbox_at, words, words_expire_at)
         values ('${BRAND_A}', 'Check Status', now(), '{a,b,c}', now() + interval '30 minutes') returning id, clip_check_status as status`,
      );
      const id = consent.rows[0].id;
      expect(consent.rows[0].status).toBeNull();
      for (const status of ["pending", "running", "done", "failed"]) {
        await db.query("update public.consents set clip_check_status = $1, clip_check_error = 'x' where id = $2", [status, id]);
      }
      await expect(db.query("update public.consents set clip_check_status = 'maybe' where id = $1", [id])).rejects.toThrow(
        /check constraint/,
      );
      await db.exec(`delete from public.consents where id = '${id}'`);
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

// Phase 3 part B: the HeyGen spend guard (lib/heygen-spend.ts) reserves a
// provider_usage row before every paid HeyGen call, capped per day.
describe("HeyGen spend guard (provider_usage + reserve_heygen_spend)", () => {
  const reserve = (kind: string, since: string, cap: number, note: string | null = "mock") =>
    db.query<{ id: string | null }>(
      "select public.reserve_heygen_spend($1, $2::timestamptz, $3, null, null, $4) as id",
      [kind, since, cap, note],
    );

  it("the default caps row exists: render 3, create_twin 2", async () => {
    const caps = await db.query<{ value: unknown }>("select value from public.app_settings where key = 'heygen_daily_caps'");
    expect(caps.rows).toEqual([{ value: { render: 3, create_twin: 2 } }]);
  });

  it("reserves until the cap, then returns null; older rows don't count", async () => {
    await asRole("service_role", null, async () => {
      await db.exec(`insert into public.provider_usage (provider, kind, status, created_at)
                     values ('heygen', 'create_twin', 'succeeded', now() - interval '2 days')`);
      const since = new Date(Date.now() - 60_000).toISOString();
      const first = (await reserve("create_twin", since, 2, null)).rows[0].id;
      const second = (await reserve("create_twin", since, 2, null)).rows[0].id;
      const third = (await reserve("create_twin", since, 2, null)).rows[0].id;
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(second).toMatch(/^[0-9a-f-]{36}$/);
      expect(third).toBeNull();
      // Renders have their own count.
      expect((await reserve("render", since, 1, null)).rows[0].id).not.toBeNull();
      const row = await db.query(
        "select provider, kind, status, cost_usd::float as cost, note, mock from public.provider_usage where id = $1",
        [first],
      );
      expect(row.rows).toEqual([{ provider: "heygen", kind: "create_twin", status: "reserved", cost: 0, note: null, mock: false }]);
      await expect(reserve("other", since, 5)).rejects.toThrow(/unknown spend kind/);
      await db.exec("delete from public.provider_usage");
    });
  });

  // Decision (a) (p3-fix2): mock rows are recorded but never count toward the cap.
  it("decision (a): 5 mock reserves over a cap of 2 all succeed and are recorded (mock = true, cost 0)", async () => {
    await asRole("service_role", null, async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const ids: (string | null)[] = [];
      for (let i = 0; i < 5; i++) ids.push((await reserve("render", since, 2, "mock")).rows[0].id);
      expect(ids.every((id) => typeof id === "string")).toBe(true);
      const rows = await db.query<{ mock: boolean; cost: number; note: string }>(
        "select mock, cost_usd::float as cost, note from public.provider_usage where kind = 'render'",
      );
      expect(rows.rows).toEqual(Array(5).fill({ mock: true, cost: 0, note: "mock" }));
      await db.exec("delete from public.provider_usage");
    });
  });

  it("decision (a): real reserves are still capped after many mock rows; the mock mark survives a note change", async () => {
    await asRole("service_role", null, async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const mockId = (await reserve("render", since, 2, "mock")).rows[0].id;
      await reserve("render", since, 2, "mock");
      // withHeygenSpend overwrites the note when a call fails; the row must stay mock.
      await db.query("update public.provider_usage set status = 'failed', note = 'HeyGen had a problem' where id = $1", [mockId]);
      expect((await reserve("render", since, 2, null)).rows[0].id).not.toBeNull();
      expect((await reserve("render", since, 2, null)).rows[0].id).not.toBeNull();
      expect((await reserve("render", since, 2, null)).rows[0].id).toBeNull();
      const counts = await db.query<{ mock: boolean; n: number }>(
        "select mock, count(*)::int as n from public.provider_usage group by mock order by mock",
      );
      expect(counts.rows).toEqual([
        { mock: false, n: 2 },
        { mock: true, n: 2 },
      ]);
      await db.exec("delete from public.provider_usage");
    });
  });

  it("decision (a): race safety unchanged: 10 real reserves at once against cap 3 (with mock rows present) → exactly 3", async () => {
    await asRole("service_role", null, async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      for (let i = 0; i < 4; i++) await reserve("render", since, 3, "mock");
      const results = await Promise.all(Array.from({ length: 10 }, () => reserve("render", since, 3, null)));
      expect(results.filter((r) => r.rows[0].id !== null)).toHaveLength(3);
      const real = await db.query<{ n: number }>("select count(*)::int as n from public.provider_usage where not mock");
      expect(real.rows).toEqual([{ n: 3 }]);
      await db.exec("delete from public.provider_usage");
    });
  });

  // SF4 (p3-fix2): the cap alert is a mocked email_outbox row, once per dedupe_key.
  it("SF4: a spend_cap_alert row is accepted once per dedupe_key; a repeat is ignored", async () => {
    await asRole("service_role", null, async () => {
      const values = `values ('owner@example.com', 'spend_cap_alert', 'Limit', 'Paused', 'spend_cap:render:2026-11-22:owner@example.com')`;
      const columns = "insert into public.email_outbox (to_email, kind, subject, body, dedupe_key)";
      expect((await db.query(`${columns} ${values} returning id`)).rows).toHaveLength(1);
      await expect(db.query(`${columns} ${values}`)).rejects.toThrow(/duplicate key/);
      // What lib/heygen-spend-store.ts does: a repeat is silently ignored.
      expect((await db.query(`${columns} ${values} on conflict (dedupe_key) do nothing returning id`)).rows).toHaveLength(0);
      // Other emails don't need a dedupe_key (null never collides).
      await db.exec(`insert into public.email_outbox (to_email, kind, subject, body) values ('a@example.com', 'consent_link', 's', 'b');
                     insert into public.email_outbox (to_email, kind, subject, body) values ('a@example.com', 'consent_link', 's', 'b');`);
      await db.exec("delete from public.email_outbox");
    });
  });

  it("kind and status only take the listed values", async () => {
    await asRole("service_role", null, async () => {
      await expect(db.exec(`insert into public.provider_usage (provider, kind) values ('heygen', 'lunch')`)).rejects.toThrow(
        /check constraint/,
      );
      await expect(
        db.exec(`insert into public.provider_usage (provider, kind, status) values ('heygen', 'render', 'maybe')`),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it("customers and logged-out visitors can't call reserve_heygen_spend or read provider_usage", async () => {
    const since = new Date().toISOString();
    await asUser(USER_A, async () => {
      await expect(reserve("render", since, 99)).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from public.provider_usage")).rejects.toThrow(/permission denied/);
    });
    await asRole("anon", null, async () => {
      await expect(reserve("render", since, 99)).rejects.toThrow(/permission denied/);
    });
  });
});

// Phase 3 part B step 2: renders (lib/render.ts), likeness tests, webhooks.
describe("renders: videos.kind, the render claim and the 10-at-once cap", () => {
  const claim = (id: string, max: number) =>
    db.query<{ result: string }>("select public.claim_render_slot($1, $2) as result", [id, max]);
  const newVideo = async (kind = "post") =>
    (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, kind) values ('${BRAND_A}', $1) returning id`,
        [kind],
      )
    ).rows[0].id;

  it("kind is post or likeness_test; 'rendered' is a status; likeness tests never count toward the plan", async () => {
    await asRole("service_role", null, async () => {
      const id = await newVideo("likeness_test");
      await db.query("update public.videos set status = 'rendered', spoken_words = 36, rendered_at = now() where id = $1", [id]);
      await expect(db.query("update public.videos set counts_toward_plan = true where id = $1", [id])).rejects.toThrow(
        /check constraint/,
      );
      await expect(newVideo("trial")).rejects.toThrow(/check constraint/);
      await expect(db.query("update public.videos set spoken_words = -1 where id = $1", [id])).rejects.toThrow(/check constraint/);
      await db.query("delete from public.videos where id = $1", [id]);
    });
  });

  it("claim_render_slot: first claim wins, a second is 'taken', a missing video is 'missing'", async () => {
    await asRole("service_role", null, async () => {
      const id = await newVideo();
      expect((await claim(id, 10)).rows[0].result).toBe("claimed");
      const row = await db.query<{ status: string; started: boolean }>(
        "select status, render_started_at is not null as started from public.videos where id = $1",
        [id],
      );
      expect(row.rows).toEqual([{ status: "rendering", started: true }]);
      expect((await claim(id, 10)).rows[0].result).toBe("taken");
      expect((await claim("90000000-0000-4000-8000-000000000999", 10)).rows[0].result).toBe("missing");
      await db.query("delete from public.videos where id = $1", [id]);
    });
  });

  it("claim_render_slot: with max videos already rendering, the next one is 'busy' and stays queued", async () => {
    await asRole("service_role", null, async () => {
      const first = await newVideo();
      const second = await newVideo();
      expect((await claim(first, 1)).rows[0].result).toBe("claimed");
      expect((await claim(second, 1)).rows[0].result).toBe("busy");
      const row = await db.query<{ status: string; started: boolean }>(
        "select status, render_started_at is not null as started from public.videos where id = $1",
        [second],
      );
      expect(row.rows).toEqual([{ status: "queued", started: false }]);
      await db.query("update public.videos set status = 'rendered' where id = $1", [first]);
      expect((await claim(second, 1)).rows[0].result).toBe("claimed");
      await db.query("delete from public.videos where id in ($1, $2)", [first, second]);
    });
  });

  it("customers and logged-out visitors can't call claim_render_slot", async () => {
    await asUser(USER_A, async () => {
      await expect(claim("90000000-0000-4000-8000-000000000999", 10)).rejects.toThrow(/permission denied/);
    });
    await asRole("anon", null, async () => {
      await expect(claim("90000000-0000-4000-8000-000000000999", 10)).rejects.toThrow(/permission denied/);
    });
  });
});

// SF2 (p3-fix2): customers may read only the plain columns of their own
// videos; everything internal (HeyGen ids, engine, errors, storage keys,
// claims, transcript, plan bookkeeping) stays server only. Likeness-test rows
// are admin-only, so customers don't see those rows at all.
describe("SF2: customers read only the safe columns of their own post videos", () => {
  const CUSTOMER_COLUMNS = ["id", "brand_id", "script_id", "status", "duration_s", "ai_label", "created_at"];
  const INTERNAL_COLUMNS = [
    "avatar_id",
    "engine",
    "attempt",
    "heygen_video_id",
    "raw_path",
    "transcript",
    "final_path",
    "counts_toward_plan",
    "watermark",
    "error",
    "kind",
    "spoken_words",
    "render_started_at",
    "rendered_at",
    "claim_cleared_at",
    "late_heygen_video_id",
    "edit_run_id",
    "edit_started_at",
  ];
  const canSelect = async (role: string, column: string) =>
    (
      await db.query<{ ok: boolean }>("select has_column_privilege($1, 'public.videos', $2, 'SELECT') as ok", [
        role,
        column,
      ])
    ).rows[0].ok;

  it("every videos column is classified (a new column must be decided on purpose)", async () => {
    const columns = await names(
      "select column_name as name from information_schema.columns where table_schema = 'public' and table_name = 'videos'",
    );
    expect(columns).toEqual([...CUSTOMER_COLUMNS, ...INTERNAL_COLUMNS].sort());
  });

  it("authenticated can SELECT each customer column", async () => {
    for (const column of CUSTOMER_COLUMNS) expect([column, await canSelect("authenticated", column)]).toEqual([column, true]);
  });

  it("authenticated can NOT select any internal column", async () => {
    for (const column of INTERNAL_COLUMNS) expect([column, await canSelect("authenticated", column)]).toEqual([column, false]);
  });

  it("anon can select no column; service_role every column", async () => {
    for (const column of [...CUSTOMER_COLUMNS, ...INTERNAL_COLUMNS]) {
      expect([column, await canSelect("anon", column)]).toEqual([column, false]);
      expect([column, await canSelect("service_role", column)]).toEqual([column, true]);
    }
  });

  it("a customer query on safe columns works; internal columns and select * are refused", async () => {
    await asUser(USER_A, async () => {
      const rows = await db.query<{ brand_id: string }>(`select ${CUSTOMER_COLUMNS.join(", ")} from public.videos`);
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((row) => row.brand_id === BRAND_A)).toBe(true);
      await expect(db.query("select * from public.videos")).rejects.toThrow(/permission denied/);
      for (const column of ["heygen_video_id", "engine", "error", "raw_path", "render_started_at"]) {
        await expect(db.query(`select ${column} from public.videos`)).rejects.toThrow(/permission denied/);
      }
    });
  });

  it("customers don't see likeness-test rows at all (admin only)", async () => {
    const id = await asRole("service_role", null, async () =>
      (
        await db.query<{ id: string }>(
          `insert into public.videos (brand_id, kind) values ('${BRAND_A}', 'likeness_test') returning id`,
        )
      ).rows[0].id,
    );
    await asUser(USER_A, async () => {
      const rows = await db.query("select id from public.videos where id = $1", [id]);
      expect(rows.rows).toEqual([]);
    });
    await asRole("service_role", null, () => db.query("delete from public.videos where id = $1", [id]));
  });
});

// Decision (b) (p3-fix2): admin "Clear stuck claim" (lib/claims.ts).
describe("clear_stuck_claim: clears a claim without a HeyGen id and audits it in one step", () => {
  const clear = (target: string, id: string) =>
    db.query<{ result: string }>("select public.clear_stuck_claim($1, $2, 'admin@example.com') as result", [target, id]);
  const audits = (column: "video_id" | "avatar_id", id: string) =>
    db.query<{ kind: string; status: string; cost: number; mock: boolean; note: string }>(
      `select kind, status, cost_usd::float as cost, mock, note from public.provider_usage where ${column} = $1`,
      [id],
    );
  // p4-fix c1: a claim may be cleared only after the render wait (31 min old here) or once failed.
  const stuckVideo = async (kind: string, heygenId: string | null = null, ageMinutes = 31) =>
    (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, kind, status, render_started_at, heygen_video_id)
         values ('${BRAND_A}', $1, 'rendering', now() - make_interval(mins => $3), $2) returning id`,
        [kind, heygenId, ageMinutes],
      )
    ).rows[0].id;

  it("a post render claim: cleared (failed, plain error), audited as claim_cleared, cost 0, not mock", async () => {
    await asRole("service_role", null, async () => {
      const id = await stuckVideo("post");
      expect((await clear("video", id)).rows[0].result).toBe("render");
      const row = await db.query("select status, render_started_at, error from public.videos where id = $1", [id]);
      expect(row.rows).toEqual([
        { status: "failed", render_started_at: null, error: "Claim cleared by an admin after checking HeyGen. Start it again when ready." },
      ]);
      expect((await audits("video_id", id)).rows).toEqual([
        { kind: "claim_cleared", status: "succeeded", cost: 0, mock: false, note: "render claim cleared by admin@example.com after checking HeyGen" },
      ]);
      await db.query("delete from public.provider_usage where video_id = $1", [id]);
      await db.query("delete from public.videos where id = $1", [id]);
    });
  });

  it("a likeness-test row holding a claim that already FAILED: cleared at once (no wait) and audited as likeness_test", async () => {
    await asRole("service_role", null, async () => {
      const id = await stuckVideo("likeness_test", null, 0);
      await db.query("update public.videos set status = 'failed' where id = $1", [id]);
      expect((await clear("video", id)).rows[0].result).toBe("likeness_test");
      expect((await audits("video_id", id)).rows.map((r) => r.note)).toEqual([
        "likeness_test claim cleared by admin@example.com after checking HeyGen",
      ]);
      await db.query("delete from public.provider_usage where video_id = $1", [id]);
      await db.query("delete from public.videos where id = $1", [id]);
    });
  });

  it("never clears a video that has a HeyGen id, or one with no claim: 'none', nothing written", async () => {
    await asRole("service_role", null, async () => {
      const withId = await stuckVideo("post", "hg_cleared_test");
      const noClaim = (await db.query<{ id: string }>(`insert into public.videos (brand_id) values ('${BRAND_A}') returning id`)).rows[0].id;
      expect((await clear("video", withId)).rows[0].result).toBe("none");
      expect((await clear("video", noClaim)).rows[0].result).toBe("none");
      const kept = await db.query<{ started: boolean }>("select render_started_at is not null as started from public.videos where id = $1", [withId]);
      expect(kept.rows).toEqual([{ started: true }]);
      expect((await db.query("select * from public.provider_usage where kind = 'claim_cleared'")).rows).toEqual([]);
      await db.query("delete from public.videos where id in ($1, $2)", [withId, noClaim]);
    });
  });

  it("a twin claim: create_started_at and error cleared, audited with the avatar id", async () => {
    await asRole("service_role", null, async () => {
      const id = (
        await db.query<{ id: string }>(
          `insert into public.avatars (brand_id, create_started_at, error) values ('${BRAND_A}', now() - interval '28 hours', 'A twin may already exist') returning id`,
        )
      ).rows[0].id;
      expect((await clear("twin", id)).rows[0].result).toBe("twin");
      const row = await db.query("select create_started_at, error from public.avatars where id = $1", [id]);
      expect(row.rows).toEqual([{ create_started_at: null, error: null }]);
      expect((await audits("avatar_id", id)).rows.map((r) => r.note)).toEqual(["twin claim cleared by admin@example.com after checking HeyGen"]);
      // A twin with a group id is never touched.
      await db.query("update public.avatars set create_started_at = now(), heygen_group_id = 'g_1' where id = $1", [id]);
      expect((await clear("twin", id)).rows[0].result).toBe("none");
      await db.query("delete from public.provider_usage where avatar_id = $1", [id]);
      await db.query("delete from public.avatars where id = $1", [id]);
    });
  });

  it("an unknown target is an error; claim_cleared rows never count toward the render cap", async () => {
    await asRole("service_role", null, async () => {
      await expect(clear("post", "90000000-0000-4000-8000-000000000999")).rejects.toThrow(/unknown claim target/);
      await db.exec(`insert into public.provider_usage (provider, kind, status) values ('heygen', 'claim_cleared', 'succeeded')`);
      const since = new Date(Date.now() - 60_000).toISOString();
      const id = await db.query<{ id: string | null }>("select public.reserve_heygen_spend('render', $1::timestamptz, 1, null, null, null) as id", [since]);
      expect(id.rows[0].id).not.toBeNull();
      await db.exec("delete from public.provider_usage");
    });
  });

  it("customers and logged-out visitors can't call it", async () => {
    await asUser(USER_A, async () => {
      await expect(clear("video", "90000000-0000-4000-8000-000000000999")).rejects.toThrow(/permission denied/);
    });
    await asRole("anon", null, async () => {
      await expect(clear("twin", "90000000-0000-4000-8000-000000000999")).rejects.toThrow(/permission denied/);
    });
  });

  // ---- p4-fix c1: the wait (HeyGen may still be making it) ----

  it("c1: a 5-minute-old render claim is REFUSED by the function itself ('too_soon', nothing written); a 31-minute-old one clears", async () => {
    await asRole("service_role", null, async () => {
      const young = await stuckVideo("post", null, 5);
      expect((await clear("video", young)).rows[0].result).toBe("too_soon");
      const kept = await db.query("select status, render_started_at is not null as claimed, claim_cleared_at from public.videos where id = $1", [young]);
      expect(kept.rows).toEqual([{ status: "rendering", claimed: true, claim_cleared_at: null }]);
      expect((await audits("video_id", young)).rows).toEqual([]);

      const old = await stuckVideo("post", null, 31);
      expect((await clear("video", old)).rows[0].result).toBe("render");
      await db.query("delete from public.provider_usage where video_id in ($1, $2)", [young, old]);
      await db.query("delete from public.videos where id in ($1, $2)", [young, old]);
    });
  });

  it("c1: the SQL wait equals RENDER.poll_max_s (source and behaviour on both sides of the line)", async () => {
    const src = await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'clear_stuck_claim'");
    expect(src.rows[0].src).toContain(`interval '${RENDER.poll_max_s} seconds'`);
    await asRole("service_role", null, async () => {
      const justBefore = await stuckVideo("post", null, RENDER.poll_max_s / 60 - 1);
      const justAfter = await stuckVideo("post", null, RENDER.poll_max_s / 60 + 1);
      expect((await clear("video", justBefore)).rows[0].result).toBe("too_soon");
      expect((await clear("video", justAfter)).rows[0].result).toBe("render");
      await db.query("delete from public.provider_usage where video_id in ($1, $2)", [justBefore, justAfter]);
      await db.query("delete from public.videos where id in ($1, $2)", [justBefore, justAfter]);
    });
  });

  it("p4-b1 5c: twins wait TWIN_POLL_MAX_S in SQL too (same number as TS): 31 min and just before → too_soon; just after → clears", async () => {
    const src = await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'clear_stuck_claim'");
    expect(src.rows[0].src).toContain(`interval '${TWIN_POLL_MAX_S} seconds'`);
    expect(src.rows[0].src).toContain(`interval '${RENDER.poll_max_s} seconds'`);
    await asRole("service_role", null, async () => {
      const insert = async (seconds: number, status = "consent_pending") =>
        (
          await db.query<{ id: string }>(
            `insert into public.avatars (brand_id, status, create_started_at) values ('${BRAND_A}', $2, now() - make_interval(secs => $1)) returning id`,
            [seconds, status],
          )
        ).rows[0].id;
      const thirtyOne = await insert(31 * 60);
      const justBefore = await insert(TWIN_POLL_MAX_S - 60);
      const justAfter = await insert(TWIN_POLL_MAX_S + 60);
      const failed = await insert(60, "failed");
      expect((await clear("twin", thirtyOne)).rows[0].result).toBe("too_soon");
      expect((await clear("twin", justBefore)).rows[0].result).toBe("too_soon");
      expect((await clear("twin", justAfter)).rows[0].result).toBe("twin");
      expect((await clear("twin", failed)).rows[0].result).toBe("twin");
      const ids = [thirtyOne, justBefore, justAfter, failed];
      await db.query("delete from public.provider_usage where avatar_id = any($1::uuid[])", [ids]);
      await db.query("delete from public.avatars where id = any($1::uuid[])", [ids]);
    });
  });

  it("c1: a 5-minute-old twin claim is refused; one older than the twin wait clears", async () => {
    await asRole("service_role", null, async () => {
      const insert = async (minutes: number) =>
        (
          await db.query<{ id: string }>(
            `insert into public.avatars (brand_id, create_started_at) values ('${BRAND_A}', now() - make_interval(mins => $1)) returning id`,
            [minutes],
          )
        ).rows[0].id;
      const young = await insert(5);
      const old = await insert(TWIN_POLL_MAX_S / 60 + 1);
      expect((await clear("twin", young)).rows[0].result).toBe("too_soon");
      expect((await clear("twin", old)).rows[0].result).toBe("twin");
      const row = await db.query<{ claimed: boolean }>("select create_started_at is not null as claimed from public.avatars where id = $1", [young]);
      expect(row.rows).toEqual([{ claimed: true }]);
      await db.query("delete from public.provider_usage where avatar_id in ($1, $2)", [young, old]);
      await db.query("delete from public.avatars where id in ($1, $2)", [young, old]);
    });
  });

  it("c2: a cleared row is retired: claim_render_slot never claims it again (a new render uses a new row)", async () => {
    await asRole("service_role", null, async () => {
      const id = await stuckVideo("post");
      expect((await clear("video", id)).rows[0].result).toBe("render");
      const row = await db.query<{ cleared: boolean }>("select claim_cleared_at is not null as cleared from public.videos where id = $1", [id]);
      expect(row.rows).toEqual([{ cleared: true }]);
      const claim = await db.query<{ result: string }>("select public.claim_render_slot($1, 10) as result", [id]);
      expect(claim.rows[0].result).toBe("taken");
      await db.query("delete from public.provider_usage where video_id = $1", [id]);
      await db.query("delete from public.videos where id = $1", [id]);
    });
  });
});

// p4-fix d: clearing a POST render claim puts the post back to 'approved'
// (so "Make video" works again) in the same transaction. Likeness tests have no post.
describe("clear_stuck_claim moves the post back to approved (p4-fix d)", () => {
  const seedPost = async (postStatus: string) => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status, status_reason)
         values ('${BRAND_A}', now(), 'Clear test', $1, 'The video could not be made. The team will look at it.') returning id`,
        [postStatus],
      )
    ).rows[0].id;
    const script = (
      await db.query<{ id: string }>(`insert into public.scripts (post_id, spoken_text, qa_status) values ($1, 'Hello.', 'passed') returning id`, [post])
    ).rows[0].id;
    const video = (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, render_started_at)
         values ('${BRAND_A}', $1, 'post', 'failed', now() - interval '40 minutes') returning id`,
        [script],
      )
    ).rows[0].id;
    return { post, script, video };
  };
  const postRow = (id: string) => db.query("select status, status_reason from public.posts where id = $1", [id]);
  const cleanup = async (post: string) => {
    await db.query("delete from public.provider_usage where kind = 'claim_cleared'");
    await db.query("delete from public.videos where script_id in (select id from public.scripts where post_id = $1)", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
  };

  it("team_review (after the poll timed out) → approved, reason cleared, with the clear", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seedPost("team_review");
      const result = await db.query<{ result: string }>("select public.clear_stuck_claim('video', $1, 'admin@example.com') as result", [video]);
      expect(result.rows[0].result).toBe("render");
      expect((await postRow(post)).rows).toEqual([{ status: "approved", status_reason: null }]);
      await cleanup(post);
    });
  });

  it("rendering (unknown state) → approved", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seedPost("rendering");
      await db.query("update public.videos set status = 'rendering' where id = $1", [video]);
      await db.query("select public.clear_stuck_claim('video', $1, 'admin@example.com')", [video]);
      expect((await postRow(post)).rows[0]).toMatchObject({ status: "approved" });
      await cleanup(post);
    });
  });

  it("a post the team already moved elsewhere (e.g. skipped) is left alone; a refused clear changes no post", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seedPost("skipped");
      await db.query("select public.clear_stuck_claim('video', $1, 'admin@example.com')", [video]);
      expect((await postRow(post)).rows[0]).toMatchObject({ status: "skipped" });
      await cleanup(post);

      const second = await seedPost("rendering");
      await db.query("update public.videos set status = 'rendering', render_started_at = now() where id = $1", [second.video]);
      const refused = await db.query<{ result: string }>("select public.clear_stuck_claim('video', $1, 'admin@example.com') as result", [second.video]);
      expect(refused.rows[0].result).toBe("too_soon");
      expect((await postRow(second.post)).rows[0]).toMatchObject({ status: "rendering" });
      await cleanup(second.post);
    });
  });
});

// p4-fix c2: a HeyGen success webhook that arrives AFTER the claim was cleared
// (or after the poll gave up). adopt_late_render decides atomically: adopt it
// (save the HeyGen id, back to 'rendering' so it downloads) or, when a newer
// render exists, only record the late id. It never touches provider_usage.
describe("adopt_late_render (late HeyGen webhook, p4-fix c2)", () => {
  const adopt = (id: string, heygenId: string) =>
    db.query<{ result: string }>("select public.adopt_late_render($1, $2) as result", [id, heygenId]);
  const seed = async () => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Late test', 'team_review') returning id`,
      )
    ).rows[0].id;
    const script = (
      await db.query<{ id: string }>(`insert into public.scripts (post_id, spoken_text, qa_status) values ($1, 'Hello.', 'passed') returning id`, [post])
    ).rows[0].id;
    const video = (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, render_started_at)
         values ('${BRAND_A}', $1, 'post', 'rendering', now() - interval '40 minutes') returning id`,
        [script],
      )
    ).rows[0].id;
    await db.query("select public.clear_stuck_claim('video', $1, 'admin@example.com')", [video]);
    return { post, script, video };
  };
  const spendRows = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.provider_usage")).rows[0].n;
  const cleanup = async (post: string) => {
    await db.query("delete from public.provider_usage");
    await db.query("delete from public.videos where script_id in (select id from public.scripts where post_id = $1)", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
  };

  it("cleared row, nothing newer: adopted (HeyGen id saved, back to rendering, post → rendering), no provider_usage row", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seed();
      const before = await spendRows();
      expect((await adopt(video, "hg_late_1")).rows[0].result).toBe("adopted");
      const row = await db.query("select status, heygen_video_id, render_started_at, late_heygen_video_id from public.videos where id = $1", [video]);
      expect(row.rows).toEqual([{ status: "rendering", heygen_video_id: "hg_late_1", render_started_at: null, late_heygen_video_id: null }]);
      expect((await db.query("select status from public.posts where id = $1", [post])).rows).toEqual([{ status: "rendering" }]);
      expect(await spendRows()).toBe(before);
      // A second call (duplicate) is not late any more.
      expect((await adopt(video, "hg_late_1")).rows[0].result).toBe("not_late");
      await cleanup(post);
    });
  });

  it("a newer render exists: only the late id is recorded; the new row is untouched; no provider_usage row", async () => {
    await asRole("service_role", null, async () => {
      const { post, script, video } = await seed();
      const newer = (
        await db.query<{ id: string }>(
          `insert into public.videos (brand_id, script_id, kind, status, render_started_at)
           values ('${BRAND_A}', $1, 'post', 'rendering', now()) returning id`,
          [script],
        )
      ).rows[0].id;
      const before = await spendRows();
      expect((await adopt(video, "hg_late_2")).rows[0].result).toBe("moved_on");
      const old = await db.query("select status, heygen_video_id, late_heygen_video_id from public.videos where id = $1", [video]);
      expect(old.rows).toEqual([{ status: "failed", heygen_video_id: null, late_heygen_video_id: "hg_late_2" }]);
      const kept = await db.query<{ status: string; heygen_video_id: string | null; claimed: boolean }>(
        "select status, heygen_video_id, render_started_at is not null as claimed from public.videos where id = $1",
        [newer],
      );
      expect(kept.rows).toEqual([{ status: "rendering", heygen_video_id: null, claimed: true }]);
      expect(await spendRows()).toBe(before);
      await cleanup(post);
    });
  });

  it("a row that is still rendering, or never reached HeyGen, is not late", async () => {
    await asRole("service_role", null, async () => {
      const rendering = await stuckVideoRow("rendering", "now()");
      const neverSent = await stuckVideoRow("failed", "null");
      expect((await adopt(rendering, "hg_x")).rows[0].result).toBe("not_late");
      expect((await adopt(neverSent, "hg_y")).rows[0].result).toBe("not_late");
      await db.query("delete from public.videos where id in ($1, $2)", [rendering, neverSent]);
    });
  });

  const stuckVideoRow = async (status: string, startedSql: string) =>
    (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, kind, status, render_started_at) values ('${BRAND_A}', 'post', $1, ${startedSql}) returning id`,
        [status],
      )
    ).rows[0].id;
});

// p4-fix e: the only supported way to lift renders_paused. Flag off + audit
// row (provider_usage kind 'renders_resumed') in ONE transaction.
describe("resume_renders (audited un-pause, p4-fix e)", () => {
  const resume = () => db.query<{ result: string }>("select public.resume_renders('admin@example.com') as result");
  const paused = async () =>
    (await db.query<{ value: unknown }>("select value from public.app_settings where key = 'renders_paused'")).rows[0]?.value;
  const audits = () =>
    db.query<{ kind: string; status: string; cost: number; mock: boolean; note: string }>(
      "select kind, status, cost_usd::float as cost, mock, note from public.provider_usage where kind = 'renders_resumed'",
    );

  it("paused → false, and exactly one audit row (cost 0, not mock, admin email in note)", async () => {
    await asRole("service_role", null, async () => {
      await db.exec("update public.app_settings set value = 'true'::jsonb where key = 'renders_paused'");
      expect((await resume()).rows[0].result).toBe("resumed");
      expect(await paused()).toBe(false);
      expect((await audits()).rows).toEqual([
        {
          kind: "renders_resumed",
          status: "succeeded",
          cost: 0,
          mock: false,
          note: "renders resumed by admin@example.com after checking today's HeyGen spend",
        },
      ]);
      await db.exec("delete from public.provider_usage");
    });
  });

  it("not paused: 'not_paused', nothing written", async () => {
    await asRole("service_role", null, async () => {
      await db.exec("update public.app_settings set value = 'false'::jsonb where key = 'renders_paused'");
      expect((await resume()).rows[0].result).toBe("not_paused");
      expect((await audits()).rows).toEqual([]);
    });
  });

  it("renders_resumed rows never count toward a daily cap", async () => {
    await asRole("service_role", null, async () => {
      await db.exec(`insert into public.provider_usage (provider, kind, status) values ('heygen', 'renders_resumed', 'succeeded')`);
      const since = new Date(Date.now() - 60_000).toISOString();
      for (const kind of ["render", "create_twin"]) {
        const id = await db.query<{ id: string | null }>("select public.reserve_heygen_spend($1, $2::timestamptz, 1, null, null, null) as id", [kind, since]);
        expect([kind, id.rows[0].id]).not.toEqual([kind, null]);
      }
      await db.exec("delete from public.provider_usage");
    });
  });

  it("customers and logged-out visitors can't call it", async () => {
    await asUser(USER_A, async () => {
      await expect(resume()).rejects.toThrow(/permission denied/);
    });
    await asRole("anon", null, async () => {
      await expect(resume()).rejects.toThrow(/permission denied/);
    });
  });
});

describe("webhook_events (HeyGen webhooks)", () => {
  it("one row per event_key: a repeat is ignored by on conflict do nothing", async () => {
    await asRole("service_role", null, async () => {
      const insert = () =>
        db.query<{ id: string }>(
          `insert into public.webhook_events (source, event_key, payload) values ('heygen', 'heygen:avatar_video.success:v1', '{}')
           on conflict (event_key) do nothing returning id`,
        );
      expect((await insert()).rows).toHaveLength(1);
      expect((await insert()).rows).toHaveLength(0);
      const count = await db.query<{ n: number }>("select count(*)::int as n from public.webhook_events");
      expect(count.rows).toEqual([{ n: 1 }]);
      await db.exec("delete from public.webhook_events");
    });
  });

  it("customers and logged-out visitors cannot read or write it", async () => {
    await asUser(USER_A, async () => {
      await expect(db.query("select * from public.webhook_events")).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`insert into public.webhook_events (source, event_key, payload) values ('heygen', 'x', '{}')`),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole("anon", null, async () => {
      await expect(db.query("select * from public.webhook_events")).rejects.toThrow(/permission denied/);
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

  // SF2: tables where customers get SELECT on some COLUMNS only, never the
  // whole table (column lists are tested in the SF2 block above).
  const COLUMN_GRANT_TABLES = ["videos"];

  it("authenticated has SELECT only on every customer table, nothing on internal ones", async () => {
    const seen: Record<string, string[]> = {};
    for (const table of await publicTables()) seen[table] = await granted("authenticated", table);
    const expected = Object.fromEntries(
      Object.keys(seen).map((t) => [
        t,
        INTERNAL_TABLES.includes(t) || COLUMN_GRANT_TABLES.includes(t) ? [] : ["SELECT"],
      ]),
    );
    expect(seen).toEqual(expected);
    expect(seen.scripts).toEqual(["SELECT"]);
    expect(seen.brand_versions).toEqual(["SELECT"]);
    expect(seen.videos).toEqual([]);
  });

  it("column-grant tables: authenticated may SELECT some columns but never INSERT/UPDATE any", async () => {
    for (const table of COLUMN_GRANT_TABLES) {
      const any = async (privilege: string) =>
        (
          await db.query<{ ok: boolean }>("select has_any_column_privilege('authenticated', $1, $2) as ok", [
            `public.${table}`,
            privilege,
          ])
        ).rows[0].ok;
      expect({ table, select: await any("SELECT"), insert: await any("INSERT"), update: await any("UPDATE") }).toEqual({
        table,
        select: true,
        insert: false,
        update: false,
      });
    }
  });

  it("anon has no SELECT, INSERT, UPDATE, DELETE or TRUNCATE on any table", async () => {
    const seen: Record<string, string[]> = {};
    for (const table of await publicTables()) seen[table] = await granted("anon", table);
    const expected = Object.fromEntries(Object.keys(seen).map((t) => [t, []]));
    expect(seen).toEqual(expected);
    expect(seen.scripts).toEqual([]);
    expect(seen.brand_versions).toEqual([]);
  });

  // Every function in public (read from pg_proc, so a new one is covered
  // automatically). Only owns_brand (used inside RLS policies) may be run by
  // customers; anon may run none. Server-only functions stay service_role only.
  it("anon and authenticated cannot EXECUTE server-only functions (claim_render_slot, reserve_heygen_spend, ...)", async () => {
    const fns = await db.query<{ sig: string; name: string }>(
      `select p.oid::regprocedure::text as sig, p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'`,
    );
    const names = fns.rows.map((f) => f.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "adopt_late_render",
        "claim_render_slot",
        "clear_stuck_claim",
        "reserve_heygen_spend",
        "resume_renders",
        "save_brand_version",
      ]),
    );
    const seen: Record<string, { anon: boolean; authenticated: boolean; service_role: boolean }> = {};
    for (const { sig, name } of fns.rows) {
      if (name === "handle_new_user") continue; // trigger function, revoked separately
      const can = async (role: string) =>
        (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, sig])).rows[0].ok;
      seen[name] = { anon: await can("anon"), authenticated: await can("authenticated"), service_role: await can("service_role") };
    }
    const expected = Object.fromEntries(
      Object.keys(seen).map((name) => [name, { anon: false, authenticated: name === "owns_brand", service_role: true }]),
    );
    expect(seen).toEqual(expected);
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

// p4-b1 (QA SF2): one edit run at a time. start_edit claims the row with the
// run's token; another run is refused while the claim is fresh; the same run
// (a Trigger.dev retry) may claim again; a claim older than the task's
// maxDuration (the run is surely dead) may be taken over.
describe("p4-b1: start_edit (one edit run at a time)", () => {
  const start = (id: string, run: string, staleS = 1800) =>
    db.query<{ ok: boolean }>("select public.start_edit($1, $2, $3) as ok", [id, run, staleS]);
  const video = async (status: string, startedSql = "null", run: string | null = null) =>
    (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, kind, status, raw_path, edit_run_id, edit_started_at)
         values ('${BRAND_A}', 'post', $1, 'raw/x.mp4', $2, ${startedSql}) returning id`,
        [status, run],
      )
    ).rows[0].id;
  const row = async (id: string) =>
    (await db.query<{ status: string; edit_run_id: string | null }>("select status, edit_run_id from public.videos where id = $1", [id])).rows[0];

  it("the first run claims a rendered video; a second run is REFUSED while the first is editing", async () => {
    await asRole("service_role", null, async () => {
      const id = await video("rendered");
      expect((await start(id, "run_a")).rows[0].ok).toBe(true);
      expect(await row(id)).toEqual({ status: "editing", edit_run_id: "run_a" });
      expect((await start(id, "run_b")).rows[0].ok).toBe(false);
      expect(await row(id)).toEqual({ status: "editing", edit_run_id: "run_a" });
      await db.query("delete from public.videos where id = $1", [id]);
    });
  });

  it("the same run may claim again (a retry after a crash); a claim older than the stale limit may be taken over", async () => {
    await asRole("service_role", null, async () => {
      const fresh = await video("editing", "now() - interval '5 minutes'", "run_a");
      expect((await start(fresh, "run_a")).rows[0].ok).toBe(true);
      const stale = await video("editing", "now() - interval '31 minutes'", "run_a");
      expect((await start(stale, "run_b")).rows[0].ok).toBe(true);
      expect(await row(stale)).toEqual({ status: "editing", edit_run_id: "run_b" });
      await db.query("delete from public.videos where id in ($1, $2)", [fresh, stale]);
    });
  });

  it("never claims a video that is final_qa (or later), a likeness test, or one without a raw file", async () => {
    await asRole("service_role", null, async () => {
      const done = await video("final_qa", "now() - interval '2 hours'", "run_a");
      expect((await start(done, "run_b")).rows[0].ok).toBe(false);
      const likeness = (
        await db.query<{ id: string }>(
          `insert into public.videos (brand_id, kind, status, raw_path) values ('${BRAND_A}', 'likeness_test', 'rendered', 'raw/y.mp4') returning id`,
        )
      ).rows[0].id;
      const noRaw = (
        await db.query<{ id: string }>(`insert into public.videos (brand_id, kind, status) values ('${BRAND_A}', 'post', 'rendered') returning id`)
      ).rows[0].id;
      expect((await start(likeness, "run_c")).rows[0].ok).toBe(false);
      expect((await start(noRaw, "run_c")).rows[0].ok).toBe(false);
      expect(await row(done)).toEqual({ status: "final_qa", edit_run_id: "run_a" });
      await db.query("delete from public.videos where id in ($1, $2, $3)", [done, likeness, noRaw]);
    });
  });
});

// p4-b1 (QA SF1): "Make video" vs a late HeyGen webhook. Both paths take the
// same per-post advisory lock (create_post_render, adopt_late_render) and a
// unique partial index allows at most one ACTIVE post video per script
// (kind = 'post', status not failed/skipped). PGlite has one connection, so
// the race is replayed step by step in QA's order (race B).
describe("p4-b1: Make video vs late webhook (create_post_render + adopt_late_render)", () => {
  const make = (post: string, script: string) =>
    db.query<{ result: { outcome: string; video_id: string | null } }>(
      `select public.create_post_render($1, $2, '${BRAND_A}', null, 'avatar_v', 3) as result`,
      [post, script],
    );
  const adopt = (id: string, heygenId: string) =>
    db.query<{ result: string }>("select public.adopt_late_render($1, $2) as result", [id, heygenId]);
  const findActive = (script: string) =>
    db.query("select id from public.videos where script_id = $1 and status not in ('failed', 'skipped')", [script]);
  /** A post whose first render (V1) was cleared after the wait: V1 failed + retired, post back to approved. */
  const seed = async () => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Race test', 'rendering') returning id`,
      )
    ).rows[0].id;
    const script = (
      await db.query<{ id: string }>(
        `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 1, 'Hello there.', 'passed') returning id`,
        [post],
      )
    ).rows[0].id;
    const v1 = (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, render_started_at)
         values ('${BRAND_A}', $1, 'post', 'rendering', now() - interval '40 minutes') returning id`,
        [script],
      )
    ).rows[0].id;
    const cleared = await db.query<{ r: string }>("select public.clear_stuck_claim('video', $1, 'admin@example.com') as r", [v1]);
    expect(cleared.rows[0].r).toBe("render");
    return { post, script, v1 };
  };
  const cleanup = async (post: string) => {
    await db.query("delete from public.provider_usage");
    await db.query("delete from public.videos where script_id in (select id from public.scripts where post_id = $1)", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
  };

  it("race B: find-active is empty → the late webhook adopts V1 → V2 is REFUSED (rpc and a raw insert); one active video", async () => {
    await asRole("service_role", null, async () => {
      const { post, script, v1 } = await seed();
      expect((await findActive(script)).rows).toEqual([]); // Make video's check sees nothing active...
      expect((await adopt(v1, "hg_late_race")).rows[0].result).toBe("adopted"); // ...then the webhook adopts V1
      const result = (await make(post, script)).rows[0].result; // ...then Make video inserts V2
      expect(result).toEqual({ outcome: "not_approved", video_id: null });
      // Even a write that skips the rpc cannot add a second active video for the script.
      await expect(
        db.query(`insert into public.videos (brand_id, script_id, kind, status) values ('${BRAND_A}', $1, 'post', 'queued')`, [script]),
      ).rejects.toMatchObject({ code: "23505" });
      expect((await findActive(script)).rows).toEqual([{ id: v1 }]);
      await cleanup(post);
    });
  });

  it("the other order: Make video first → the late webhook only records the id (moved_on)", async () => {
    await asRole("service_role", null, async () => {
      const { post, script, v1 } = await seed();
      const made = (await make(post, script)).rows[0].result;
      expect(made.outcome).toBe("created");
      expect((await adopt(v1, "hg_late_other")).rows[0].result).toBe("moved_on");
      expect((await findActive(script)).rows).toEqual([{ id: made.video_id }]);
      await cleanup(post);
    });
  });

  it("create_post_render: a second call returns the existing video; a post that is not approved is refused", async () => {
    await asRole("service_role", null, async () => {
      const { post, script } = await seed();
      const first = (await make(post, script)).rows[0].result;
      const second = (await make(post, script)).rows[0].result;
      expect(first.outcome).toBe("created");
      expect(second).toEqual({ outcome: "existing", video_id: first.video_id });
      await db.query("update public.posts set status = 'team_review' where id = $1", [post]);
      const other = (
        await db.query<{ id: string }>(
          `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 2, 'Hi.', 'passed') returning id`,
          [post],
        )
      ).rows[0].id;
      expect((await make(post, other)).rows[0].result).toEqual({ outcome: "not_approved", video_id: null });
      await cleanup(post);
    });
  });

  it("QA NICE: a newer script exists → the late render of the old script is only recorded (moved_on)", async () => {
    await asRole("service_role", null, async () => {
      const { post, v1 } = await seed();
      await db.query(`insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 2, 'Rewritten.', 'passed')`, [post]);
      expect((await adopt(v1, "hg_late_old_script")).rows[0].result).toBe("moved_on");
      const row = await db.query("select status, heygen_video_id, late_heygen_video_id from public.videos where id = $1", [v1]);
      expect(row.rows).toEqual([{ status: "failed", heygen_video_id: null, late_heygen_video_id: "hg_late_old_script" }]);
      expect((await db.query("select status from public.posts where id = $1", [post])).rows).toEqual([{ status: "approved" }]);
      await cleanup(post);
    });
  });

  it("both functions take the same per-post advisory lock; the index is unique and partial", async () => {
    const src = async (name: string) =>
      (await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = $1", [name])).rows[0].src;
    const lock = "pg_advisory_xact_lock(hashtext('post_render'), hashtext(";
    expect(await src("create_post_render")).toContain(lock);
    expect(await src("adopt_late_render")).toContain(lock);
    const index = await db.query<{ def: string }>(
      "select indexdef as def from pg_indexes where schemaname = 'public' and indexname = 'videos_one_active_post_video'",
    );
    expect(index.rows[0]?.def).toMatch(/CREATE UNIQUE INDEX .* \(script_id\) WHERE .*kind = 'post'.*failed.*skipped/);
  });

  it("customers and logged-out visitors can't call create_post_render (or start_edit)", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(db.query("select public.start_edit($1, 'run', 1800)", [POST_A])).rejects.toThrow(/permission denied/);
      });
    }
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(make(POST_A, POST_A)).rejects.toThrow(/permission denied/);
      });
    }
  });
});
