require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ===============================
   SUPABASE SETUP
================================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ===============================
   OPENAI SETUP
================================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ===============================
   HELPERS
================================= */

// Get business by Twilio number
async function getBusinessByPhone(phoneNumber) {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("phone_number", phoneNumber)
    .single();

  if (error) {
    console.error("Business lookup error:", error.message);
    return null;
  }

  return data;
}

// Store conversation
async function storeConversation(businessId, userPhone, channel, message) {
  await supabase.from("conversations").insert([
    {
      business_id: businessId,
      user_phone: userPhone,
      channel,
      message,
    },
  ]);
}

// Generate AI reply
async function generateAIReply(systemPrompt, userInput) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ],
  });

  return completion.choices[0].message.content;
}

/* ===============================
   ROUTES
================================= */

app.get("/", (req, res) => {
  res.send("Ebi SaaS backend is running");
});

// Voice start
app.post("/voice", async (req, res) => {
  console.log("Twilio To:", req.body.To);
  console.log("Twilio From:", req.body.From);
  
  const toNumber = req.body.To;

  const business = await getBusinessByPhone(toNumber);

  if (!business) {
    return res.type("text/xml").send(`
<Response>
  <Say>This number is not configured.</Say>
</Response>
    `);
  }

  const twiml = `
<Response>
  <Say>Hello, thank you for calling ${business.business_name}. How can I help you today?</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
  `;

  res.type("text/xml").send(twiml);
});

// Voice process
app.post("/process", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult;
    const toNumber = req.body.To;
    const fromNumber = req.body.From;

    const business = await getBusinessByPhone(toNumber);

    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Say>This number is not configured.</Say>
</Response>
      `);
    }

    let aiReply = "Sorry, I didn't catch that.";

    if (userSpeech) {
      aiReply = await generateAIReply(
        business.system_prompt,
        userSpeech
      );

      await storeConversation(
        business.id,
        fromNumber,
        "voice",
        userSpeech
      );
    }

    const twiml = `
<Response>
  <Say>${aiReply}</Say>
  <Gather input="speech" action="/process" method="POST" timeout="5" />
</Response>
    `;

    res.type("text/xml").send(twiml);
  } catch (error) {
    console.error("Voice error:", error.message);

    res.type("text/xml").send(`
<Response>
  <Say>Sorry, something went wrong.</Say>
</Response>
    `);
  }
});

// SMS
app.post("/sms", async (req, res) => {
  try {
    const userMessage = req.body.Body;
    const toNumber = req.body.To;
    const fromNumber = req.body.From;

    const business = await getBusinessByPhone(toNumber);

    if (!business) {
      return res.type("text/xml").send(`
<Response>
  <Message>This number is not configured.</Message>
</Response>
      `);
    }

    let aiReply = "Sorry, I didn't understand that.";

    if (userMessage) {
      aiReply = await generateAIReply(
        business.system_prompt,
        userMessage
      );

      await storeConversation(
        business.id,
        fromNumber,
        "sms",
        userMessage
      );
    }

    const twiml = `
<Response>
  <Message>${aiReply}</Message>
</Response>
    `;

    res.type("text/xml").send(twiml);
  } catch (error) {
    console.error("SMS error:", error.message);

    res.type("text/xml").send(`
<Response>
  <Message>Sorry, something went wrong.</Message>
</Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});