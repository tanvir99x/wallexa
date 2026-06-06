import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "WallexAI running" });
});

app.post("/api/ai", async (req, res) => {
  try {
    const message = req.body.message;

    const response = await client.chat.completions.create({
      model: process.env.MODEL || "gpt-5-chat",
      messages: [
        { role: "system", content: "You are WallexAI." },
        { role: "user", content: message }
      ]
    });

    res.json({
      reply: response.choices[0].message.content
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => {
  console.log("🚀 WallexAI running on http://localhost:8080");
});