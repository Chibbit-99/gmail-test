import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const kv = await Deno.openKv();

const RATE_WINDOW = 15 * 60 * 1000; // 15 min
const QUEUE_KEY = ["email-queue"];

// ================= HELPERS =================

function getIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for") ??
    req.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}

function cors(res: Response) {
  const headers = new Headers(res.headers);

  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "content-type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");

  return new Response(res.body, {
    status: res.status,
    headers,
  });
}

function json(data: unknown, status = 200) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ================= RATE LIMIT =================

async function checkRateLimit(ip: string, email: string) {
  const key = ["rate-limit", ip, email];
  const now = Date.now();

  const record = await kv.get<number>(key);

  if (record.value && now - record.value < RATE_WINDOW) {
    return {
      ok: false,
      retry: Math.ceil((RATE_WINDOW - (now - record.value)) / 60000),
    };
  }

  await kv.set(key, now);
  return { ok: true };
}

// ================= QUEUE =================

async function queueEmail(data: any) {
  const list = (await kv.get<any[]>(QUEUE_KEY)).value ?? [];

  list.push({
    ...data,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  });

  await kv.set(QUEUE_KEY, list);
}

// ================= EMAIL SENDER =================

async function sendEmail(job: any) {
  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: {
        username: Deno.env.get("GMAIL_USER")!,
        password: Deno.env.get("GMAIL_APP_PASSWORD")!,
      },
    },
  });

  await client.send({
    from: Deno.env.get("GMAIL_USER")!,
    to: job.recipient,
    subject: "Message from API",
    content: job.fallback ?? "HTML email",
    html: job.html ?? undefined,
  });
}

// ================= WORKER =================

async function processQueue() {
  const list = (await kv.get<any[]>(QUEUE_KEY)).value ?? [];
  if (list.length === 0) return;

  const [job, ...rest] = list;

  try {
    await sendEmail(job);
    await kv.set(QUEUE_KEY, rest);
  } catch (err) {
    console.error("Email failed:", err);
  }
}

setInterval(processQueue, 5000);

// ================= SERVER =================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }

  const { recipient, html, fallback } = body;

  if (!recipient || (!html && !fallback)) {
    return json({
      success: false,
      error: "Missing recipient or content",
    }, 400);
  }

  const ip = getIP(req);

  // RATE LIMIT (REAL protection)
  const limit = await checkRateLimit(ip, recipient);

  if (!limit.ok) {
    return json(
      {
        success: false,
        error: "Rate limited",
        retry_in_minutes: limit.retry,
      },
      429,
    );
  }

  await queueEmail({ recipient, html, fallback });

  return json({
    success: true,
    message: "Queued for sending",
  });
});
