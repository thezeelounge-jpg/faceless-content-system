// Runs our real migration on an in-memory Postgres (PGlite) with small stand-ins
// for Supabase's auth schema and roles, then proves the access rules work:
// user A can never see user B's data, and customers can't write anything.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIO_QA, RENDER, TWIN_POLL_MAX_S, VISUAL_QA } from "@/lib/qa/config";
import { HUMAN_CHECKLIST, HUMAN_REJECT_REASONS, REJECT_CUSTOMER_REASON } from "@/lib/qa/human-review";

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
    "post_id", // p4-b3 (Q8): server only like every new column
    "edit_manifest", // p5-a2: what the editor built (Gate 4 checks it)
    "rerender_of", // p5-a2: a QA re-render points at the video it replaced
    "qa_fix_note", // p5-a2: the automatic fix that made this video
    "rerender_gate", // p5-b2: which gate's automatic fix made this video (server only)
    "delivered_at", // p5-b3: when the video reached the customer (Quality: time to Ready)
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
  const INTERNAL_TABLES = ["ai_usage", "app_settings", "brand_qa_settings", "email_outbox", "human_reviews", "provider_usage", "qa_reports", "webhook_events"];
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
      // Trigger functions, revoked from everyone (a trigger fires without EXECUTE; p4-b3 inserts above prove it).
      if (name === "handle_new_user" || name === "videos_fill_post_id" || name === "posts_stamp_script_approved") {
        for (const role of ["anon", "authenticated"]) {
          expect((await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, sig])).rows[0].ok).toBe(false);
        }
        // p5-a (QA NICE): the server role may run the post_id trigger function explicitly too (p5-b4: and the approved_at one).
        if (name === "videos_fill_post_id" || name === "posts_stamp_script_approved") {
          expect((await db.query<{ ok: boolean }>("select has_function_privilege('service_role', $1, 'EXECUTE') as ok", [sig])).rows[0].ok).toBe(true);
        }
        continue;
      }
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

  it("both functions take the same per-post advisory lock; the index is unique, partial and PER POST (p4-b3, Q8)", async () => {
    const src = async (name: string) =>
      (await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = $1", [name])).rows[0].src;
    const lock = "pg_advisory_xact_lock(hashtext('post_render'), hashtext(";
    expect(await src("create_post_render")).toContain(lock);
    expect(await src("adopt_late_render")).toContain(lock);
    const index = async (name: string) =>
      (await db.query<{ def: string }>("select indexdef as def from pg_indexes where schemaname = 'public' and indexname = $1", [name])).rows[0]
        ?.def;
    expect(await index("videos_one_active_post_video_per_post")).toMatch(
      /CREATE UNIQUE INDEX .* \(post_id\) WHERE .*kind = 'post'.*failed.*skipped/,
    );
    expect(await index("videos_one_active_post_video")).toBeUndefined(); // the per-script one is replaced
  });

  // p4-b3 (Q8): a post CAN get a second live script: two overlapping "Run checks" runs, one
  // passing v1 (post → approved) while the other is still rewriting (lib/qa/script-pipeline.ts
  // inserts v2 with no post-status guard). Make video for v1, then for v2, must not give the post
  // two active videos (two paid renders). The guard is now per post (videos.post_id).
  it("Q8: v1 has an active video, then a newer v2 passes → Make video for v2 is refused (other_script); a raw insert too", async () => {
    await asRole("service_role", null, async () => {
      const { post } = await seed(); // post back to approved; V0 cleared (failed)
      const v1 = (await db.query<{ id: string }>("select id from public.scripts where post_id = $1 and version = 1", [post])).rows[0].id;
      const first = (await make(post, v1)).rows[0].result;
      expect(first.outcome).toBe("created");
      const v2 = (
        await db.query<{ id: string }>(
          `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 2, 'Rewritten.', 'passed') returning id`,
          [post],
        )
      ).rows[0].id;
      expect((await make(post, v2)).rows[0].result).toEqual({ outcome: "other_script", video_id: first.video_id });
      await expect(
        db.query(`insert into public.videos (brand_id, script_id, kind, status) values ('${BRAND_A}', $1, 'post', 'queued')`, [v2]),
      ).rejects.toMatchObject({ code: "23505" });
      const active = await db.query(
        "select id from public.videos where post_id = $1 and kind = 'post' and status not in ('failed', 'skipped')",
        [post],
      );
      expect(active.rows).toEqual([{ id: first.video_id }]);
      await cleanup(post);
    });
  });

  it("Q8: videos.post_id is filled from the script (insert and script change); likeness tests have none", async () => {
    const cols = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'videos'",
    );
    expect(cols.rows.map((c) => c.column_name)).toContain("post_id");
    await asRole("service_role", null, async () => {
      const { post, script, v1 } = await seed();
      expect((await db.query("select post_id from public.videos where id = $1", [v1])).rows).toEqual([{ post_id: post }]);
      // A raw insert that forgets post_id still gets it (trigger), so the per-post index always applies.
      const other = (
        await db.query<{ id: string }>(
          `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Other', 'approved') returning id`,
        )
      ).rows[0].id;
      const otherScript = (
        await db.query<{ id: string }>(`insert into public.scripts (post_id, version, qa_status) values ($1, 1, 'passed') returning id`, [other])
      ).rows[0].id;
      await db.query("update public.videos set script_id = $1 where id = $2", [otherScript, v1]);
      expect((await db.query("select post_id from public.videos where id = $1", [v1])).rows).toEqual([{ post_id: other }]);
      await db.query("update public.videos set script_id = $1 where id = $2", [script, v1]);
      const likeness = (
        await db.query<{ post_id: string | null }>(
          `insert into public.videos (brand_id, kind, status) values ('${BRAND_A}', 'likeness_test', 'queued') returning post_id`,
        )
      ).rows[0];
      expect(likeness).toEqual({ post_id: null });
      await db.query("delete from public.videos where kind = 'likeness_test' and brand_id = $1 and script_id is null", [BRAND_A]);
      await db.query("delete from public.scripts where post_id = $1", [other]);
      await db.query("delete from public.posts where id = $1", [other]);
      await cleanup(post);
    });
  });

  // p5-a: the database itself re-checks that the script passed QA (not only lib/render.ts),
  // so a direct rpc call for a pending, failed or team_review script is refused.
  it("p5-a: create_post_render refuses a script that has not passed QA, even when called directly", async () => {
    await asRole("service_role", null, async () => {
      const { post } = await seed(); // post approved; v1 passed; V0 cleared
      for (const qa of ["pending", "failed", "team_review"]) {
        const script = (
          await db.query<{ id: string }>(
            `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, (select coalesce(max(version), 0) + 1 from public.scripts where post_id = $1), 'Not checked.', $2) returning id`,
            [post, qa],
          )
        ).rows[0].id;
        expect((await make(post, script)).rows[0].result).toEqual({ outcome: "not_approved", video_id: null });
      }
      const active = await db.query("select id from public.videos where post_id = $1 and status not in ('failed', 'skipped')", [post]);
      expect(active.rows).toEqual([]);
      // The newest script passes → allowed again.
      const passed = (
        await db.query<{ id: string }>(
          `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 99, 'Checked.', 'passed') returning id`,
          [post],
        )
      ).rows[0].id;
      expect((await make(post, passed)).rows[0].result.outcome).toBe("created");
      await cleanup(post);
    });
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

// p5-a: a script rewrite (a new scripts version from the gates) is saved only while the post is
// still being scripted (planned / scripting). An admin override inserts anyway, moves the post
// back to scripting and writes a provider_usage audit row (kind 'script_override'), in one step.
describe("p5-a: insert_script_version (no rewrites after scripting; audited admin override)", () => {
  const ROW = (post: string, version: number) =>
    JSON.stringify({
      post_id: post, version, hook: "Hook.", body: "Body.", cta: "Call.", display_text: "Hook. Body. Call.", est_seconds: 5,
      captions: {}, hashtags: ["a"], broll_keywords: ["coffee"], edit_plan: { emphasis_words: [] }, qa_status: "pending", spoken_text: null,
    });
  const insert = (post: string, version: number, by: string | null = null, reason: string | null = null) =>
    db.query<{ result: { outcome: string; script_id: string | null } }>(
      "select public.insert_script_version($1::jsonb, $2, $3) as result",
      [ROW(post, version), by, reason],
    );
  const newPost = async (status: string) =>
    (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Rewrite guard', $1) returning id`,
        [status],
      )
    ).rows[0].id;
  const versions = async (post: string) =>
    (await db.query<{ version: number }>("select version from public.scripts where post_id = $1 order by version", [post])).rows.map((r) => r.version);
  const audits = async () =>
    (await db.query<{ note: string }>("select note from public.provider_usage where kind = 'script_override' order by created_at")).rows;
  const cleanup = async (post: string) => {
    await db.query("delete from public.provider_usage where kind = 'script_override'");
    await db.query("delete from public.videos where post_id = $1", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
  };

  it("allowed while the post is planned or scripting (no audit row)", async () => {
    await asRole("service_role", null, async () => {
      for (const status of ["planned", "scripting"]) {
        const post = await newPost(status);
        const result = (await insert(post, 2)).rows[0].result;
        expect(result.outcome).toBe("inserted");
        expect(await versions(post)).toEqual([2]);
        expect(await audits()).toEqual([]);
        await cleanup(post);
      }
    });
  });

  it("refused once the post has left scripting (nothing saved, post unchanged)", async () => {
    await asRole("service_role", null, async () => {
      for (const status of ["script_review", "approved", "rendering", "team_review", "needs_you", "ready"]) {
        const post = await newPost(status);
        expect((await insert(post, 2)).rows[0].result).toEqual({ outcome: "closed", script_id: null });
        expect(await versions(post)).toEqual([]);
        expect((await db.query("select status from public.posts where id = $1", [post])).rows).toEqual([{ status }]);
        await cleanup(post);
      }
    });
  });

  it("admin override: inserts, post back to scripting, one audit row naming the admin, the post status and the reason", async () => {
    await asRole("service_role", null, async () => {
      const post = await newPost("team_review");
      const result = (await insert(post, 3, "admin@example.com", "Client asked for a new angle")).rows[0].result;
      expect(result.outcome).toBe("overridden");
      expect(await versions(post)).toEqual([3]);
      expect((await db.query("select status, status_reason from public.posts where id = $1", [post])).rows).toEqual([
        { status: "scripting", status_reason: null },
      ]);
      const rows = await db.query<{ provider: string; status: string; cost_usd: string; mock: boolean; note: string }>(
        "select provider, status, cost_usd::text, mock, note from public.provider_usage where kind = 'script_override'",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ provider: "other", status: "succeeded", cost_usd: "0.0000", mock: false });
      expect(rows.rows[0].note).toContain("admin@example.com");
      expect(rows.rows[0].note).toContain("team_review");
      expect(rows.rows[0].note).toContain("Client asked for a new angle");
      expect(rows.rows[0].note).toContain(result.script_id!);
      await cleanup(post);
    });
  });

  it("admin override is refused while the post has an active video (no insert, no audit)", async () => {
    await asRole("service_role", null, async () => {
      const post = await newPost("rendering");
      const v1 = (
        await db.query<{ id: string }>(
          `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 1, 'Hi.', 'passed') returning id`,
          [post],
        )
      ).rows[0].id;
      await db.query(`insert into public.videos (brand_id, script_id, kind, status) values ('${BRAND_A}', $1, 'post', 'rendering')`, [v1]);
      expect((await insert(post, 2, "admin@example.com", "New angle")).rows[0].result).toEqual({ outcome: "has_video", script_id: null });
      expect(await versions(post)).toEqual([1]);
      expect(await audits()).toEqual([]);
      await cleanup(post);
    });
  });

  it("customers and logged-out visitors can't call insert_script_version", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(insert(POST_A, 9)).rejects.toThrow(/permission denied/);
      });
    }
  });
});

// p5-b1 (Rowan 7): only the post's LATEST script version may set its qa_status and move the post.
describe("p5-b1: finish_script_checks (the checks' verdict counts only for the latest version)", () => {
  const finish = (script: string, qa: string | null, status: string, reason: string | null = null) =>
    db.query<{ result: { outcome: string } }>("select public.finish_script_checks($1, $2, $3, $4) as result", [script, qa, status, reason]);
  const seed = async (postStatus: string, versions: number[]) => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Latest only', $1) returning id`,
        [postStatus],
      )
    ).rows[0].id;
    const ids: string[] = [];
    for (const v of versions) {
      ids.push(
        (
          await db.query<{ id: string }>(
            `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, $2, 'Hi.', 'pending') returning id`,
            [post, v],
          )
        ).rows[0].id,
      );
    }
    return { post, ids };
  };
  const state = async (post: string) => ({
    post: (await db.query("select status, status_reason from public.posts where id = $1", [post])).rows[0],
    scripts: (await db.query("select version, qa_status from public.scripts where post_id = $1 order by version", [post])).rows,
  });
  const cleanup = (post: string) => db.query("delete from public.posts where id = $1", [post]);

  it("the latest version: sets its qa_status and moves a scripting post → 'done'", async () => {
    await asRole("service_role", null, async () => {
      const { post, ids } = await seed("scripting", [1, 2]);
      expect((await finish(ids[1], "passed", "script_review")).rows[0].result).toEqual({ outcome: "done" });
      expect(await state(post)).toEqual({
        post: { status: "script_review", status_reason: null },
        scripts: [{ version: 1, qa_status: "pending" }, { version: 2, qa_status: "passed" }],
      });
      await cleanup(post);
    });
  });

  it("an older version while a newer one exists → 'stale': nothing written (not the post, not either script)", async () => {
    await asRole("service_role", null, async () => {
      const { post, ids } = await seed("scripting", [1, 2]);
      const before = await state(post);
      expect((await finish(ids[0], "team_review", "team_review", "Script QA failed")).rows[0].result).toEqual({ outcome: "stale" });
      expect((await finish(ids[0], null, "approved")).rows[0].result).toEqual({ outcome: "stale" });
      expect(await state(post)).toEqual(before);
      await cleanup(post);
    });
  });

  it("a post that already moved on → 'moved_on': the script row is updated, the post is not", async () => {
    await asRole("service_role", null, async () => {
      const { post, ids } = await seed("approved", [1]);
      expect((await finish(ids[0], "failed", "needs_you", "Please look")).rows[0].result).toEqual({ outcome: "moved_on" });
      expect(await state(post)).toEqual({ post: { status: "approved", status_reason: null }, scripts: [{ version: 1, qa_status: "failed" }] });
      await cleanup(post);
    });
  });

  it("an unknown script → 'not_found'; a post status that is not a check outcome is refused", async () => {
    await asRole("service_role", null, async () => {
      expect((await finish("30000000-0000-4000-8000-00000000beef", null, "approved")).rows[0].result).toEqual({ outcome: "not_found" });
      const { post, ids } = await seed("scripting", [1]);
      await expect(finish(ids[0], null, "ready")).rejects.toThrow(/not a script-check outcome/);
      await cleanup(post);
    });
  });

  it("customers and logged-out visitors can't call finish_script_checks", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(finish("30000000-0000-4000-8000-00000000beef", null, "approved")).rejects.toThrow(/permission denied/);
      });
    }
  });
});

// p5-a2 (Gate 3 auto-fix): one QA re-render per post video, our cost. Under the same per-post lock
// as create_post_render / adopt_late_render: the checked video (audio_qa, attempt 1, newest script)
// becomes failed and ONE new queued video is made: attempt 2, counts_toward_plan = false,
// rerender_of = the old video, qa_fix_note = the fix. A second re-render is refused ('limit').
describe("p5-a2: create_qa_rerender (one automatic re-render, never counted)", () => {
  const rerender = (video: string, note = "Respelled Ayesha → Aa-ee-sha.") =>
    db.query<{ result: { outcome: string; video_id: string | null } }>("select public.create_qa_rerender($1, 12, $2) as result", [video, note]);
  const seed = async (status = "audio_qa") => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Gate 3', 'audio_qa') returning id`,
      )
    ).rows[0].id;
    const script = (
      await db.query<{ id: string }>(
        `insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 1, 'Hi.', 'passed') returning id`,
        [post],
      )
    ).rows[0].id;
    const video = (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, engine, heygen_video_id, ai_label, watermark)
         values ('${BRAND_A}', $1, 'post', $2, 'avatar_v', 'hg_' || gen_random_uuid(), true, true) returning id`,
        [script, status],
      )
    ).rows[0].id;
    return { post, script, video };
  };
  const row = async (id: string) =>
    (
      await db.query<Record<string, unknown>>(
        `select status, attempt, counts_toward_plan, rerender_of, qa_fix_note, post_id, script_id, engine, spoken_words, ai_label, watermark,
                heygen_video_id, render_started_at from public.videos where id = $1`,
        [id],
      )
    ).rows[0];
  const cleanup = async (post: string) => {
    await db.query("delete from public.videos where post_id = $1", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
  };

  it("makes one queued attempt-2 video that never counts; the checked video fails; a second re-render is refused", async () => {
    await asRole("service_role", null, async () => {
      const { post, script, video } = await seed();
      const made = (await rerender(video)).rows[0].result;
      expect(made.outcome).toBe("created");
      expect(await row(video)).toMatchObject({ status: "failed", attempt: 1 });
      expect(await row(made.video_id!)).toEqual({
        status: "queued", attempt: 2, counts_toward_plan: false, rerender_of: video, qa_fix_note: "Respelled Ayesha → Aa-ee-sha.",
        post_id: post, script_id: script, engine: "avatar_v", spoken_words: 12, ai_label: true, watermark: true,
        heygen_video_id: null, render_started_at: null,
      });
      // The re-render itself fails Gate 3 → no third render (AUDIO_QA.max_rerenders = 1).
      await db.query("update public.videos set status = 'audio_qa' where id = $1", [made.video_id]);
      expect((await rerender(made.video_id!)).rows[0].result).toEqual({ outcome: "limit", video_id: null });
      expect((await db.query("select count(*)::int as n from public.videos where post_id = $1", [post])).rows).toEqual([{ n: 2 }]);
      await cleanup(post);
    });
  });

  it("refused unless the video is being audio-checked and still says the post's newest script", async () => {
    await asRole("service_role", null, async () => {
      for (const status of ["rendered", "editing", "final_qa", "team_review", "failed"]) {
        const { post, video } = await seed(status);
        expect((await rerender(video)).rows[0].result).toEqual({ outcome: "not_allowed", video_id: null });
        expect(await row(video)).toMatchObject({ status });
        await cleanup(post);
      }
      const { post, video } = await seed();
      await db.query(`insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 2, 'New.', 'passed')`, [post]);
      expect((await rerender(video)).rows[0].result).toEqual({ outcome: "not_allowed", video_id: null });
      await cleanup(post);
      expect((await rerender("90000000-0000-4000-8000-00000000dead")).rows[0].result).toEqual({ outcome: "not_found", video_id: null });
    });
  });

  it("takes the per-post render lock; the SQL limit equals AUDIO_QA.max_rerenders", async () => {
    const src = (await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'create_qa_rerender'")).rows[0].src;
    expect(src).toContain("pg_advisory_xact_lock(hashtext('post_render'), hashtext(");
    expect(src).toContain(`v_video.attempt > ${AUDIO_QA.max_rerenders}`);
  });

  it("customers and logged-out visitors can't call create_qa_rerender", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(rerender(POST_A)).rejects.toThrow(/permission denied/);
      });
    }
  });
});

// p5-a: migrations written to be re-run. 20261122180000 is ALREADY applied on staging and is
// not edited. Its follow-up 20261122190000 (and 20261122200000) use IF NOT EXISTS /
// CREATE OR REPLACE / DROP ... IF EXISTS, so applying them again changes nothing. A fresh
// database gets the whole chain, then each re-runnable file again, and the schema must match.
describe("p5-a: re-runnable migrations leave the same schema", () => {
  const RERUNNABLE = [
    "20261122190000", "20261122200000", "20261122210000", "20261122220000", "20261122230000", "20261123000000", "20261123010000",
    "20261123020000",
  ];
  const FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const sqlOf = (version: string) => {
    const file = FILES.find((f) => f.startsWith(`${version}_`));
    expect(file, `migration ${version}`).toBeDefined();
    return readFileSync(path.join(MIGRATIONS_DIR, file!), "utf8");
  };

  /** Everything a migration in this repo can change: columns, indexes, triggers, functions, privileges, policies. */
  async function schemaSnapshot(fresh: PGlite) {
    const q = async (sql: string) => (await fresh.query(sql)).rows;
    return {
      columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
                        where table_schema = 'public' order by 1, 2`),
      indexes: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`),
      triggers: await q(`select t.tgname, pg_get_triggerdef(t.oid) as def from pg_trigger t join pg_class c on c.oid = t.tgrelid
                         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal order by 1`),
      functions: await q(`select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as def, p.proacl::text as acl
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`),
      tables: await q(`select c.relname, c.relacl::text as acl, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where n.nspname = 'public' and c.relkind = 'r' order by 1`),
      columnAcl: await q(`select c.relname, a.attname, a.attacl::text as acl from pg_attribute a join pg_class c on c.oid = a.attrelid
                          join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and a.attacl is not null order by 1, 2`),
      policies: await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`),
    };
  }

  it("the chain applies, then 190000 and 200000 apply again with no error and no change; 180000 is not re-run (it would stop and change nothing)", async () => {
    const fresh = await PGlite.create();
    try {
      await fresh.exec(SUPABASE_STUBS);
      for (const migration of MIGRATIONS) await fresh.exec(migration);
      const before = await schemaSnapshot(fresh);
      for (const version of RERUNNABLE) await fresh.exec(sqlOf(version));
      for (const version of RERUNNABLE) await fresh.exec(sqlOf(version)); // and a third time
      expect(await schemaSnapshot(fresh)).toEqual(before);
      // The applied 180000 file is left as it is: run again it fails at once ("already exists")
      // and, being one implicit transaction, leaves the schema untouched. db push never re-runs it.
      await expect(fresh.exec(sqlOf("20261122180000"))).rejects.toThrow(/already exists/);
      expect(await schemaSnapshot(fresh)).toEqual(before);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});

// p5-b2 (Gate 5 + the usage rule). Migration 20261123000000:
//  - create_visual_rerender: Gate 5's ONE automatic re-render per script (VISUAL_QA.max_fixes), our cost:
//    the checked final_qa video fails, one queued video is made (attempt + 1, counts_toward_plan = false,
//    rerender_gate = 'visual'). Under the per-post render lock.
//  - deliver_post_video: the ONE delivered video per post counts: video final_qa → ready + counts = true,
//    every other video of the post counts = false, post → ready. Under the per-post render lock.
//  - brand_qa_settings: server-only switch "the team reviews every video" for managed brands.
describe("p5-b2: create_visual_rerender, deliver_post_video, brand_qa_settings", () => {
  const seed = async (status = "final_qa", attempt = 1) => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status) values ('${BRAND_A}', now(), 'Gate 5', 'final_qa') returning id`,
      )
    ).rows[0].id;
    const script = (
      await db.query<{ id: string }>(`insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 1, 'Hi.', 'passed') returning id`, [post])
    ).rows[0].id;
    const video = (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, engine, attempt, spoken_words, heygen_video_id, ai_label, watermark)
         values ('${BRAND_A}', $1, 'post', $2, 'avatar_v', $3, 9, 'hg_' || gen_random_uuid(), true, false) returning id`,
        [script, status, attempt],
      )
    ).rows[0].id;
    return { post, script, video };
  };
  const rerender = (video: string, note = "Gate 5: re-rendered once (face).") =>
    db.query<{ result: { outcome: string; video_id: string | null } }>("select public.create_visual_rerender($1, $2) as result", [video, note]);
  const deliver = (video: string) => db.query<{ result: { outcome: string } }>("select public.deliver_post_video($1) as result", [video]);
  const row = async (id: string) =>
    (
      await db.query<Record<string, unknown>>(
        `select status, attempt, counts_toward_plan, rerender_of, rerender_gate, qa_fix_note, post_id, script_id, engine, spoken_words, ai_label, watermark, heygen_video_id
         from public.videos where id = $1`,
        [id],
      )
    ).rows[0];
  const postRow = async (id: string) => (await db.query<Record<string, unknown>>("select status, status_reason from public.posts where id = $1", [id])).rows[0];
  const cleanup = async (post: string) => {
    await db.query("delete from public.videos where post_id = $1", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
  };

  it("create_visual_rerender: one queued video (attempt + 1, never counted, rerender_gate visual); a second is refused for the same script", async () => {
    await asRole("service_role", null, async () => {
      const { post, script, video } = await seed("final_qa", 2);
      const made = (await rerender(video)).rows[0].result;
      expect(made.outcome).toBe("created");
      expect(await row(video)).toMatchObject({ status: "failed", counts_toward_plan: false });
      expect(await row(made.video_id!)).toEqual({
        status: "queued", attempt: 3, counts_toward_plan: false, rerender_of: video, rerender_gate: "visual",
        qa_fix_note: "Gate 5: re-rendered once (face).", post_id: post, script_id: script, engine: "avatar_v", spoken_words: 9,
        ai_label: true, watermark: false, heygen_video_id: null,
      });
      await db.query("update public.videos set status = 'final_qa' where id = $1", [made.video_id]);
      expect((await rerender(made.video_id!)).rows[0].result).toEqual({ outcome: "limit", video_id: null });
      await cleanup(post);
    });
  });

  it("create_visual_rerender: refused unless final_qa and the post's newest script; unknown id → not_found", async () => {
    await asRole("service_role", null, async () => {
      for (const status of ["audio_qa", "editing", "team_review", "ready", "failed"]) {
        const { post, video } = await seed(status);
        expect((await rerender(video)).rows[0].result).toEqual({ outcome: "not_allowed", video_id: null });
        expect(await row(video)).toMatchObject({ status });
        await cleanup(post);
      }
      const { post, video } = await seed();
      await db.query(`insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 2, 'New.', 'passed')`, [post]);
      expect((await rerender(video)).rows[0].result).toEqual({ outcome: "not_allowed", video_id: null });
      await cleanup(post);
      expect((await rerender("90000000-0000-4000-8000-00000000dead")).rows[0].result).toEqual({ outcome: "not_found", video_id: null });
    });
  });

  it("deliver_post_video: the delivered video is ready and counts; every other video of the post does not; the post is ready", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seed("failed");
      // An older failed attempt that (wrongly) says it counts: delivery clears it.
      await db.query("update public.videos set counts_toward_plan = true where id = $1", [video]);
      const second = (
        await db.query<{ id: string }>(
          `insert into public.videos (brand_id, script_id, kind, status, attempt) select brand_id, script_id, 'post', 'final_qa', 2 from public.videos where id = $1 returning id`,
          [video],
        )
      ).rows[0].id;
      expect((await deliver(second)).rows[0].result).toEqual({ outcome: "delivered" });
      expect(await row(second)).toMatchObject({ status: "ready", counts_toward_plan: true });
      expect(await row(video)).toMatchObject({ status: "failed", counts_toward_plan: false });
      expect(await postRow(post)).toEqual({ status: "ready", status_reason: null });
      // Twice: nothing more (the video is no longer final_qa).
      expect((await deliver(second)).rows[0].result).toEqual({ outcome: "not_allowed" });
      await cleanup(post);
    });
  });

  it("deliver_post_video: refused unless final_qa (team_review stays uncounted); unknown id → not_found", async () => {
    await asRole("service_role", null, async () => {
      for (const status of ["team_review", "audio_qa", "editing", "failed"]) {
        const { post, video } = await seed(status);
        expect((await deliver(video)).rows[0].result).toEqual({ outcome: "not_allowed" });
        expect(await row(video)).toMatchObject({ status, counts_toward_plan: false });
        expect((await postRow(post)).status).toBe("final_qa");
        await cleanup(post);
      }
      expect((await deliver("90000000-0000-4000-8000-00000000dead")).rows[0].result).toEqual({ outcome: "not_found" });
    });
  });

  it("both take the per-post render lock; the SQL limit equals VISUAL_QA.max_fixes", async () => {
    for (const fn of ["create_visual_rerender", "deliver_post_video"]) {
      const src = (await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = $1", [fn])).rows[0].src;
      expect(src).toContain("pg_advisory_xact_lock(hashtext('post_render'), hashtext(");
    }
    const src = (await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'create_visual_rerender'")).rows[0].src;
    expect(src).toContain(`>= ${VISUAL_QA.max_fixes}`);
  });

  it("customers and logged-out visitors can't call either function, nor read brand_qa_settings", async () => {
    await asRole("service_role", null, async () => {
      await db.query(`insert into public.brand_qa_settings (brand_id, team_reviews_every_video) values ('${BRAND_A}', false) on conflict do nothing`);
    });
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(rerender(POST_A)).rejects.toThrow(/permission denied/);
        await expect(deliver(POST_A)).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.brand_qa_settings")).rejects.toThrow(/permission denied/);
      });
    }
    await asRole("service_role", null, async () => {
      expect((await db.query("select team_reviews_every_video from public.brand_qa_settings where brand_id = $1", [BRAND_A])).rows).toEqual([
        { team_reviews_every_video: false },
      ]);
      await db.query(`delete from public.brand_qa_settings where brand_id = '${BRAND_A}'`);
    });
  });

  it("rerender_gate accepts only audio or visual; brand_qa_settings has RLS on", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seed();
      await expect(db.query("update public.videos set rerender_gate = 'customer' where id = $1", [video])).rejects.toThrow(/check constraint/);
      await cleanup(post);
    });
    expect((await db.query<{ on: boolean }>("select relrowsecurity as on from pg_class where relname = 'brand_qa_settings'")).rows).toEqual([{ on: true }]);
  });
});

// p5-b3 (Gate 6, the admin QA queue). Migration 20261123010000:
//  - review_queued_video(video, decision, checklist, reason, note, admin): only a post video still in
//    team_review; approve needs EVERY checklist item ticked and a finished edit (final_path): video +
//    post → ready, this video is the post's ONE counted video, delivered_at set; reject: video failed
//    (never counted), post → problem with the reason. Both write a qa_reports row (gate 'human') and ONE
//    provider_usage audit row (kind 'human_review', cost 0) in the same transaction. A second submit
//    finds the video no longer in the queue and changes nothing.
//  - deliver_post_video now also sets delivered_at.
describe("p5-b3: review_queued_video (Gate 6 approve / reject)", () => {
  const ALL_TICKED = Object.fromEntries(HUMAN_CHECKLIST.map((item) => [item, true]));
  const seed = async (status = "team_review", finalPath: string | null = "final/b/v/runs/r1.mp4") => {
    const post = (
      await db.query<{ id: string }>(
        `insert into public.posts (brand_id, scheduled_for, title, status, status_reason) values ('${BRAND_A}', now(), 'Gate 6', 'team_review', 'First 5 videos') returning id`,
      )
    ).rows[0].id;
    const script = (
      await db.query<{ id: string }>(`insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 1, 'Hi.', 'passed') returning id`, [post])
    ).rows[0].id;
    const video = (
      await db.query<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, attempt, final_path) values ('${BRAND_A}', $1, 'post', $2, 2, $3) returning id`,
        [script, status, finalPath],
      )
    ).rows[0].id;
    return { post, script, video };
  };
  const review = (video: string, decision: string, checklist: Record<string, boolean>, reason: string | null = null, note: string | null = null) =>
    db.query<{ result: { outcome: string } }>("select public.review_queued_video($1, $2, $3, $4, $5, $6) as result", [
      video,
      decision,
      JSON.stringify(checklist),
      reason,
      note,
      "ops@example.com",
    ]);
  const videoRow = async (id: string) =>
    (
      await db.query<Record<string, unknown>>(
        "select status, counts_toward_plan, error, delivered_at is not null as delivered from public.videos where id = $1",
        [id],
      )
    ).rows[0];
  const postRow = async (id: string) => (await db.query<Record<string, unknown>>("select status, status_reason from public.posts where id = $1", [id])).rows[0];
  const humanReports = async (video: string) =>
    (await db.query<Record<string, unknown>>("select gate, passed, issues, script_id from public.qa_reports where video_id = $1 and gate = 'human'", [video])).rows;
  const audits = async () =>
    (
      await db.query<{ note: string; provider: string; cost_usd: string; mock: boolean; status: string }>(
        "select note, provider, cost_usd::text, mock, status from public.provider_usage where kind = 'human_review' order by created_at",
      )
    ).rows;
  const cleanup = async (post: string) => {
    await db.query("delete from public.videos where post_id = $1", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
    await db.query("delete from public.provider_usage where kind = 'human_review'");
    await db.query("delete from public.human_reviews where post_id = $1", [post]);
  };

  it("approve with every box ticked: video + post ready, the ONE counted video, delivered_at, a human report, one audit row; a double submit changes nothing", async () => {
    await asRole("service_role", null, async () => {
      const { post, script, video } = await seed();
      const older = (
        await db.query<{ id: string }>(
          `insert into public.videos (brand_id, script_id, kind, status, attempt, counts_toward_plan) values ('${BRAND_A}', $1, 'post', 'failed', 1, true) returning id`,
          [script],
        )
      ).rows[0].id;
      expect((await review(video, "approve", ALL_TICKED)).rows[0].result).toEqual({ outcome: "approved", brand_id: BRAND_A });
      expect(await videoRow(video)).toEqual({ status: "ready", counts_toward_plan: true, error: null, delivered: true });
      expect(await videoRow(older)).toMatchObject({ counts_toward_plan: false });
      expect(await postRow(post)).toEqual({ status: "ready", status_reason: null });
      expect(await humanReports(video)).toEqual([{ gate: "human", passed: true, issues: [], script_id: script }]);
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider: "other", cost_usd: "0.0000", mock: false, status: "succeeded" });
      expect(rows[0].note).toContain(video);
      expect(rows[0].note).toContain("approved by ops@example.com");
      // Double submit: the video left the queue; nothing more is written.
      expect((await review(video, "approve", ALL_TICKED)).rows[0].result).toEqual({ outcome: "not_in_queue" });
      expect(await humanReports(video)).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
      await cleanup(post);
    });
  });

  it("approve is refused unless every checklist item is ticked, and without a finished edit", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seed();
      for (const missing of HUMAN_CHECKLIST) {
        expect((await review(video, "approve", { ...ALL_TICKED, [missing]: false })).rows[0].result).toEqual({ outcome: "checklist_incomplete" });
      }
      const withoutFirst = Object.fromEntries(Object.entries(ALL_TICKED).slice(1));
      expect((await review(video, "approve", withoutFirst)).rows[0].result).toEqual({ outcome: "checklist_incomplete" });
      expect(await videoRow(video)).toMatchObject({ status: "team_review", counts_toward_plan: false });
      expect(await humanReports(video)).toEqual([]);
      await cleanup(post);
      const raw = await seed("team_review", null);
      expect((await review(raw.video, "approve", ALL_TICKED)).rows[0].result).toEqual({ outcome: "no_final_file" });
      expect(await videoRow(raw.video)).toMatchObject({ status: "team_review" });
      expect(await audits()).toEqual([]);
      await cleanup(raw.post);
    });
  });

  it("reject: video failed and never counted, post → approved (p5-b4) with a neutral reason, a failed human report, one audit row; twice → not_in_queue", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seed();
      expect((await review(video, "reject", {}, "lip_sync", "Mouth drifts at 0:07.")).rows[0].result).toEqual({ outcome: "rejected" });
      expect(await videoRow(video)).toMatchObject({ status: "failed", counts_toward_plan: false, delivered: false });
      expect(await postRow(post)).toEqual({ status: "approved", status_reason: REJECT_CUSTOMER_REASON });
      const reports = await humanReports(video);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        passed: false,
        issues: [{ code: "human_lip_sync", detail: "Mouth drifts at 0:07.", at_seconds: null, severity: "hard" }],
      });
      expect((await audits())[0].note).toContain("rejected by ops@example.com");
      expect((await review(video, "reject", {}, "lip_sync", "again")).rows[0].result).toEqual({ outcome: "not_in_queue" });
      expect(await humanReports(video)).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
      await cleanup(post);
    });
  });

  it("reject needs a known reason; unknown decisions, videos outside the queue and unknown ids are refused", async () => {
    await asRole("service_role", null, async () => {
      const { post, video } = await seed();
      expect((await review(video, "reject", {}, "boring")).rows[0].result).toEqual({ outcome: "bad_input" });
      expect((await review(video, "reject", {}, null)).rows[0].result).toEqual({ outcome: "bad_input" });
      expect((await review(video, "maybe", ALL_TICKED)).rows[0].result).toEqual({ outcome: "bad_input" });
      expect(await videoRow(video)).toMatchObject({ status: "team_review" });
      await cleanup(post);
      for (const status of ["final_qa", "ready", "failed", "audio_qa"]) {
        const other = await seed(status);
        expect((await review(other.video, "approve", ALL_TICKED)).rows[0].result).toEqual({ outcome: "not_in_queue" });
        expect((await review(other.video, "reject", {}, "other", "x")).rows[0].result).toEqual({ outcome: "not_in_queue" });
        expect(await videoRow(other.video)).toMatchObject({ status });
        await cleanup(other.post);
      }
      expect((await review("90000000-0000-4000-8000-00000000dead", "approve", ALL_TICKED)).rows[0].result).toEqual({ outcome: "not_found" });
      expect(await audits()).toEqual([]);
    });
  });

  it("the SQL lists match lib/qa/human-review.ts; per-post render lock; deliver_post_video sets delivered_at", async () => {
    const src = (await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'review_queued_video'")).rows[0]?.src;
    expect(src).toContain("pg_advisory_xact_lock(hashtext('post_render'), hashtext(");
    expect(HUMAN_CHECKLIST).toEqual(["pronunciation", "lip_sync", "looks_real", "captions", "broll", "music", "label"]);
    for (const item of HUMAN_CHECKLIST) expect(src).toContain(`'${item}'`);
    for (const reason of HUMAN_REJECT_REASONS) expect(src).toContain(`'${reason}'`);
    await asRole("service_role", null, async () => {
      const { post, video } = await seed("final_qa");
      await db.query("select public.deliver_post_video($1)", [video]);
      expect(await videoRow(video)).toMatchObject({ status: "ready", delivered: true });
      await cleanup(post);
    });
  });

  it("customers and logged-out visitors can't call it, nor read the human reports or the audit rows", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await asRole(role, USER_A, async () => {
        await expect(review(POST_A, "approve", ALL_TICKED)).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.qa_reports where gate = 'human'")).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.provider_usage where kind = 'human_review'")).rejects.toThrow(/permission denied/);
      });
    }
  });
});

// p5-b4 (migration 20261123020000):
//  - QA SF2: the reject reason + the admin's note live ONLY in human_reviews (server only: RLS on, no
//    policies, no grants to anon / authenticated). posts.status_reason (customers read it) gets a
//    neutral sentence, never the note.
//  - Rowan 6: a reject puts the post back to 'approved' (no automatic re-render; Make video again).
//  - Rowan 5: the usage rule across every fix: only the one delivered video of a post counts.
//  - Rowan 7: scripts.approved_at is stamped when a post is approved before it has any video
//    (trigger posts_stamp_script_approved, so every approve path is covered).
describe("p5-b4: Gate 6 reject is admin-only, back to approved; usage rule; scripts.approved_at", () => {
  const ALL_TICKED = Object.fromEntries(HUMAN_CHECKLIST.map((item) => [item, true]));
  const NOTE = "Internal: mouth drifts at 0:07, client hates the shirt.";
  const review = (video: string, decision: string, checklist: Record<string, boolean>, reason: string | null = null, note: string | null = null) =>
    db.query<{ result: { outcome: string } }>("select public.review_queued_video($1, $2, $3, $4, $5, $6) as result", [
      video,
      decision,
      JSON.stringify(checklist),
      reason,
      note,
      "ops@example.com",
    ]);
  const one = async <T,>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows[0];
  const seedPost = async (brand: string, status: string) => {
    const post = (await one<{ id: string }>(`insert into public.posts (brand_id, scheduled_for, title, status) values ($1, now(), 'p5-b4', $2) returning id`, [brand, status])).id;
    const script = (await one<{ id: string }>(`insert into public.scripts (post_id, version, spoken_text, qa_status) values ($1, 1, 'Hi.', 'passed') returning id`, [post])).id;
    return { post, script };
  };
  const queuedVideo = async (brand: string, script: string) =>
    (
      await one<{ id: string }>(
        `insert into public.videos (brand_id, script_id, kind, status, final_path) values ($1, $2, 'post', 'team_review', 'final/b/v/runs/r1.mp4') returning id`,
        [brand, script],
      )
    ).id;
  const makeVideo = (post: string, script: string, brand: string) =>
    one<{ result: { outcome: string; video_id: string | null } }>("select public.create_post_render($1, $2, $3, null, 'avatar_v', 12) as result", [post, script, brand]);
  const cleanup = async (post: string) => {
    await db.query("delete from public.human_reviews where post_id = $1", [post]);
    await db.query("delete from public.videos where post_id = $1", [post]);
    await db.query("delete from public.posts where id = $1", [post]);
    await db.query("delete from public.provider_usage where kind = 'human_review'");
  };

  it("reject: reason + note saved ONLY in human_reviews; posts.status_reason is neutral and never holds the note", async () => {
    const { post, video } = await asRole("service_role", null, async () => {
      const { post, script } = await seedPost(BRAND_A, "team_review");
      const video = await queuedVideo(BRAND_A, script);
      expect((await review(video, "reject", {}, "lip_sync", NOTE)).rows[0].result).toEqual({ outcome: "rejected" });
      expect(await one("select video_id, post_id, decision, reason, note, admin from public.human_reviews where video_id = $1", [video])).toEqual({
        video_id: video,
        post_id: post,
        decision: "reject",
        reason: "lip_sync",
        note: NOTE,
        admin: "ops@example.com",
      });
      const p = await one<{ status_reason: string }>("select status_reason from public.posts where id = $1", [post]);
      expect(p.status_reason).toBe(REJECT_CUSTOMER_REASON);
      expect(p.status_reason).not.toContain("mouth drifts");
      expect(p.status_reason).not.toMatch(/lip_sync|QA queue|reject/i);
      return { post, video };
    });
    // The owner sees only the neutral sentence on their own post.
    await asUser(USER_A, async () => {
      expect(await one("select status, status_reason from public.posts where id = $1", [post])).toEqual({ status: "approved", status_reason: REJECT_CUSTOMER_REASON });
    });
    // Nobody but the server can read human_reviews: the owner, a second account, logged-out visitors.
    for (const [role, user] of [["authenticated", USER_A], ["authenticated", USER_B], ["anon", null]] as const) {
      await asRole(role, user, async () => {
        await expect(db.query("select note from public.human_reviews")).rejects.toThrow(/permission denied/);
        await expect(db.query("select reason from public.human_reviews where video_id = $1", [video])).rejects.toThrow(/permission denied/);
      });
    }
    await asRole("service_role", null, () => cleanup(post));
  });

  it("human_reviews: RLS on, no policies, nothing granted to anon or authenticated; approve is recorded there too", async () => {
    expect(await one("select relrowsecurity as rls from pg_class where oid = 'public.human_reviews'::regclass")).toEqual({ rls: true });
    expect((await db.query("select policyname from pg_policies where schemaname = 'public' and tablename = 'human_reviews'")).rows).toEqual([]);
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect([role, privilege, (await one<{ ok: boolean }>("select has_table_privilege($1, 'public.human_reviews', $2) as ok", [role, privilege])).ok]).toEqual([
          role,
          privilege,
          false,
        ]);
      }
    }
    await asRole("service_role", null, async () => {
      const { post, script } = await seedPost(BRAND_A, "team_review");
      const video = await queuedVideo(BRAND_A, script);
      expect((await review(video, "approve", ALL_TICKED)).rows[0].result).toMatchObject({ outcome: "approved" });
      expect(await one("select decision, reason, note, admin from public.human_reviews where video_id = $1", [video])).toEqual({
        decision: "approve",
        reason: null,
        note: null,
        admin: "ops@example.com",
      });
      await cleanup(post);
    });
  });

  it("reject → post approved, NO automatic re-render (no new video, no spend row); Make video again works; approve → that video is the one counted", async () => {
    await asRole("service_role", null, async () => {
      const { post, script } = await seedPost(BRAND_A, "team_review");
      const video = await queuedVideo(BRAND_A, script);
      const spendBefore = (await one<{ n: number }>("select count(*)::int as n from public.provider_usage where kind in ('render', 'create_twin')")).n;
      expect((await review(video, "reject", {}, "looks_real", NOTE)).rows[0].result).toEqual({ outcome: "rejected" });
      expect((await one<{ n: number }>("select count(*)::int as n from public.videos where post_id = $1", [post])).n).toBe(1);
      expect((await one<{ n: number }>("select count(*)::int as n from public.provider_usage where kind in ('render', 'create_twin')")).n).toBe(spendBefore);
      expect(await one("select status, counts_toward_plan from public.videos where id = $1", [video])).toEqual({ status: "failed", counts_toward_plan: false });
      expect(await one("select status from public.posts where id = $1", [post])).toEqual({ status: "approved" });

      const again = (await makeVideo(post, script, BRAND_A)).result;
      expect(again.outcome).toBe("created");
      await db.query("update public.videos set status = 'team_review', final_path = 'final/x.mp4' where id = $1", [again.video_id]);
      expect((await review(again.video_id!, "approve", ALL_TICKED)).rows[0].result).toMatchObject({ outcome: "approved" });
      const counted = (await db.query<{ id: string }>("select id from public.videos where post_id = $1 and counts_toward_plan", [post])).rows;
      expect(counted).toEqual([{ id: again.video_id }]);
      await cleanup(post);
    });
  });

  it("usage rule: Gate 3 re-render, Gate 5 re-render, a re-edit, a Gate 6 reject, Make video again, approve → exactly ONE counted video (the delivered one)", async () => {
    await asRole("service_role", null, async () => {
      const { post, script } = await seedPost(BRAND_A, "approved");
      const counts = async () =>
        (await db.query<{ id: string; counts_toward_plan: boolean }>("select id, counts_toward_plan from public.videos where post_id = $1 order by created_at", [post])).rows;

      const v1 = (await makeVideo(post, script, BRAND_A)).result.video_id!;
      await db.query("update public.videos set status = 'audio_qa' where id = $1", [v1]);
      const v2 = (await one<{ r: { video_id: string } }>("select public.create_qa_rerender($1, 12, 'Gate 3 respelling') as r", [v1])).r.video_id; // Gate 3
      await db.query("update public.videos set status = 'final_qa', final_path = 'final/2.mp4' where id = $1", [v2]);
      const v3 = (await one<{ r: { video_id: string } }>("select public.create_visual_rerender($1, 'Gate 5 face') as r", [v2])).r.video_id; // Gate 5 re-render
      // Gate 5 re-edit of v3 (same row: final_qa → audio_qa → final_qa), then the auto-fixed video waits in the queue.
      await db.query("update public.videos set status = 'final_qa', final_path = 'final/3.mp4' where id = $1", [v3]);
      await db.query("update public.videos set status = 'audio_qa', qa_fix_note = 'Gate 5: re-edited once' where id = $1", [v3]);
      await db.query("update public.videos set status = 'team_review' where id = $1", [v3]);
      expect((await counts()).every((v) => !v.counts_toward_plan)).toBe(true);
      expect((await review(v3, "reject", {}, "captions", NOTE)).rows[0].result).toEqual({ outcome: "rejected" });
      expect((await counts()).every((v) => !v.counts_toward_plan)).toBe(true);

      const v4 = (await makeVideo(post, script, BRAND_A)).result.video_id!;
      await db.query("update public.videos set status = 'team_review', final_path = 'final/4.mp4' where id = $1", [v4]);
      expect((await review(v4, "approve", ALL_TICKED)).rows[0].result).toMatchObject({ outcome: "approved" });

      const rows = await counts();
      expect(rows.map((r) => r.id)).toEqual([v1, v2, v3, v4]);
      expect(rows.map((r) => r.counts_toward_plan)).toEqual([false, false, false, true]);
      expect(await one("select status from public.posts where id = $1", [post])).toEqual({ status: "ready" });
      await cleanup(post);
    });
  });

  it("approved_at: stamped when the checks approve the post (finish_script_checks), not on script_review; a later approve (person) stamps it; back to approved after a video never moves it", async () => {
    await asRole("service_role", null, async () => {
      const approvedAt = async (script: string) => (await one<{ at: string | null }>("select approved_at as at from public.scripts where id = $1", [script])).at;

      // Self-serve: the checks approve it.
      const a = await seedPost(BRAND_A, "scripting");
      await db.query("update public.scripts set qa_status = 'pending' where id = $1", [a.script]);
      expect(await approvedAt(a.script)).toBeNull();
      await db.query("select public.finish_script_checks($1, 'passed', 'approved', null)", [a.script]);
      const first = await approvedAt(a.script);
      expect(first).not.toBeNull();

      // Managed: script_review does not stamp; a person's approve does.
      const b = await seedPost(BRAND_A, "scripting");
      await db.query("select public.finish_script_checks($1, 'passed', 'script_review', null)", [b.script]);
      expect(await approvedAt(b.script)).toBeNull();
      await db.query("update public.posts set status = 'approved' where id = $1", [b.post]);
      expect(await approvedAt(b.script)).not.toBeNull();

      // After a video exists, going back to approved (claim cleared, Gate 6 reject, re-render not sent) keeps the first stamp.
      const v = (await makeVideo(a.post, a.script, BRAND_A)).result.video_id!;
      await db.query("update public.videos set status = 'team_review', final_path = 'final/a.mp4' where id = $1", [v]);
      await db.query("update public.posts set status = 'team_review' where id = $1", [a.post]);
      await db.query("update public.scripts set approved_at = '2026-11-01T00:00:00Z' where id = $1", [a.script]);
      expect((await review(v, "reject", {}, "other", "x")).rows[0].result).toEqual({ outcome: "rejected" });
      expect(new Date((await approvedAt(a.script))!).toISOString()).toBe("2026-11-01T00:00:00.000Z");
      await cleanup(a.post);
      await cleanup(b.post);
    });
  });
});
