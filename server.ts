// server.ts
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const recipient = url.searchParams.get("email");

  if (!recipient) {
    return new Response(
      "Usage: ?email=someone@example.com",
      { status: 400 },
    );
  }

  try {
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
      to: recipient,
      subject: "Hello from Deno",
      content: "This email was sent when someone visited the URL.",
    });

    return new Response(`Sent email to ${recipient}`);
  } catch (err) {
    console.error(err);
    return new Response(`Error: ${err}`, { status: 500 });
  }
});
