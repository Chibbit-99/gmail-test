import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET")!;

const DATABASE_URL = Deno.env.get("DATABASE_URL_SECRET")!;

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MOD = 62n ** 30n;
const A = 123456789123456789123456789n;
const B = 987654321987654321987654321n;

function encodeBase62(n: bigint): string {
    let s = "";

    for (let i = 0; i < 30; i++) {
        s = CHARS[Number(n % 62n)] + s;
        n /= 62n;
    }

    return s;
}

export function generateToken(): string {
    const x = BigInt(Date.now());
    const y = (A * x + B) % MOD;
    return encodeBase62(y);
}

export async function readPath(path: string = ""): Promise<any> {
    const url = `${DATABASE_URL}/${path}.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Read failed: ${response.status}`);
    return await response.json();
}

export async function updatePath(path: string, data: any): Promise<void> {
    const url = `${DATABASE_URL}/${path}.json`;
    const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error(`Update failed: ${response.status}`);
}

export async function deletePath(path: string): Promise<void> {
    const url = `${DATABASE_URL}/${path}.json`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
}

// ---------------- CORS ----------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function cors(res: Response) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function json(data: unknown, status = 200) {
  return cors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ---------------- IP ----------------

function getIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for") ??
    req.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}

// ---------------- TURNSTILE VERIFY ----------------

async function verifyTurnstile(token: string, ip: string) {
  const form = new FormData();
  form.append("secret", TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form },
  );

  return await res.json();
}

// ---------------- EMAIL TEMPLATE ----------------

async function buildEmail(recipient: string, password: string) {
  const token = generateToken();
  const appURL = "auth.scspace.app"
  const html = `
    <div style="font-family:Arial;padding:20px;line-height:1.5">
      <h2 style="color:#4f46e5;">Welcome to SC Space!! 👋</h2>

      <p>If you did not request this email you can safely ignore it.</p>

      <div style="margin-top:20px;padding:15px;background:#f3f4f6;border-radius:8px;">
        <p><b>Your magic link: </b><a href=${appURL}?token=${token}>Click Here!!</a></p>
        <p><b>Click the above link to complete the signup process.</b></p>
      </div>

      <p style="margin-top:20px;font-size:12px;color:#666;">
        This is an automated message. Recipient: ${recipient}
      </p>
    </div>
  `;

  const fallback = `Welcome to SC Space! To complete the signup email, click this link: ${appURL}?token=${token}. This is an automated message. Recipient: ${recipient} If you did not request this email you can safely ignore it.`;
  const safeRecipient = recipient.replace(/\./g, ","); 

  // Update using the safe key
  await updatePath("", { [safeRecipient]: [token, password] });


  return { html, fallback };
}

// ---------------- SERVER ----------------

Deno.serve(async (req) => {
  // ✅ OPTIONS must return CORS headers directly, not via cors() wrapper
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ✅ Wrap everything so any uncaught error still returns CORS headers
  try {
    if (req.method !== "GET") {
      return json({ error: "Use GET" }, 405);
    }

    const url = new URL(req.url);
    const email = url.searchParams.get("email");
    const token = url.searchParams.get("token");
    const password = url.searchParams.get("password");

    if (!email || !token || !password) {
      return json({ success: false, error: "Missing ?email, ?password and ?token" }, 400);
    }

    const ip = getIP(req);

    // ---------------- VERIFY TURNSTILE ----------------

    const verify = await verifyTurnstile(token, ip);

    if (!verify.success) {
      return json({ success: false, error: "Turnstile verification failed" }, 403);
    }

    const safeRecipient = email.replace(/\./g, ","); 
    const existingUser = await readPath(`/${safeRecipient}`)
    if (existingUser) {
        if (existingUser[1] == password) {
            return json({ success: true, message: "Token exists", token: existingUser[0] });
        } else {
            return json({ success: false, message: "Invalid Credentials"});
        }
    } else {
        const { html, fallback } = await buildEmail(email,password);
    
        // ---------------- SEND EMAIL ----------------
    
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
          to: email,
          subject: "SC Space signup verification email",
          content: fallback,
          html,
        });
        return json({ success: true, message: "Email sent", to: email });
    }
  } catch (err) {
    // ✅ Errors are now caught here and always return with CORS headers
    return json({ success: false, error: String(err) }, 500);
  }
});
