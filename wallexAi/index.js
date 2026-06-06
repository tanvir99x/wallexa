import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Load environment variables
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment variables.");
  process.exit(1);
}

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Basic MCP server structure (JSON-RPC over stdio)
process.stdin.on("data", async (chunk) => {
  try {
    const request = JSON.parse(chunk.toString());

    if (request.method === "wallexai.chat") {
      const userMessage = request.params?.message || "";

      const model = genAI.getGenerativeModel({ model: "gemini-pro" });
      const response = await model.generateContent(userMessage);
      const replyText = response.response.text();

      const rpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          reply: replyText
        }
      };

      process.stdout.write(JSON.stringify(rpcResponse));
    }
  } catch (err) {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { message: err.message }
    };
    process.stdout.write(JSON.stringify(errorResponse));
  }
});