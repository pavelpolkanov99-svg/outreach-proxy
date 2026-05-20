// poster.js — LinkedIn comment poster via Playwright
// Railway service: linkedin-poster
// Start command: node poster.js
// Env vars needed:
//   LI_COOKIES   — JSON string of LinkedIn cookies (from browser export)
//   PORT         — set by Railway automatically

const express    = require("express");
const { chromium } = require("playwright");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "1mb" }));

// Parse LinkedIn cookies from env
// Format: JSON array of cookie objects (export from browser via EditThisCookie or similar)
function getCookies() {
  const raw = process.env.LI_COOKIES;
  if (!raw) throw new Error("LI_COOKIES env var not set");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("LI_COOKIES is not valid JSON");
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "linkedin-poster",
    cookiesSet: !!process.env.LI_COOKIES,
  });
});

// POST /linkedin/comment
// Body: { postUrl: string, commentText: string }
// Returns: { ok: true } or { ok: false, error: string }
app.post("/linkedin/comment", async (req, res) => {
  const { postUrl, commentText } = req.body || {};

  if (!postUrl)     return res.status(400).json({ ok: false, error: "postUrl required" });
  if (!commentText) return res.status(400).json({ ok: false, error: "commentText required" });
  if (commentText.length > 1250) return res.status(400).json({ ok: false, error: "commentText too long (max 1250 chars)" });

  let browser;
  try {
    const cookies = getCookies();

    console.log(`[poster] launching browser for: ${postUrl}`);

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    // Inject LinkedIn cookies
    await context.addCookies(cookies.map(c => ({
      name:     c.name,
      value:    c.value,
      domain:   c.domain || ".linkedin.com",
      path:     c.path || "/",
      secure:   c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: "Lax",
    })));

    const page = await context.newPage();

    // Navigate to post
    console.log(`[poster] navigating to ${postUrl}`);
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);

    // Check if we're logged in (redirect to login page = cookies expired)
    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
      throw new Error("LinkedIn session expired — please refresh LI_COOKIES");
    }

    // Click "Comment" button — LinkedIn uses aria-label
    console.log("[poster] looking for comment button...");
    const commentBtn = await page.locator("button[aria-label*='comment' i], button[aria-label*='Comment' i]").first();
    await commentBtn.waitFor({ timeout: 10000 });
    await commentBtn.click();

    // Wait for comment box to appear
    await page.waitForTimeout(1000);

    // Find the comment text area
    const commentBox = await page.locator(
      "div.comments-comment-box__form div[contenteditable='true'], " +
      "div[data-testid='comment-texteditor'] div[contenteditable='true'], " +
      "div.ql-editor[contenteditable='true']"
    ).first();
    await commentBox.waitFor({ timeout: 10000 });

    // Type comment with human-like delay
    console.log("[poster] typing comment...");
    await commentBox.click();
    await page.waitForTimeout(500);

    // Type character by character with small delays (human imitation)
    for (const char of commentText) {
      await commentBox.type(char, { delay: 20 + Math.random() * 30 });
    }

    await page.waitForTimeout(800 + Math.random() * 400);

    // Submit comment
    console.log("[poster] submitting comment...");
    const submitBtn = await page.locator(
      "button[aria-label*='Post comment' i], " +
      "button.comments-comment-box__submit-button, " +
      "form.comments-comment-box button[type='submit']"
    ).first();
    await submitBtn.waitFor({ timeout: 5000 });
    await submitBtn.click();

    // Wait for comment to appear
    await page.waitForTimeout(2000);

    console.log("[poster] comment posted successfully");
    await browser.close();

    return res.json({ ok: true, message: "Comment posted successfully" });

  } catch (err) {
    console.error("[poster] error:", err.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[poster] LinkedIn poster service running on port ${PORT}`);
  console.log(`[poster] LI_COOKIES: ${process.env.LI_COOKIES ? "SET" : "NOT SET — service will fail"}`);
});
