import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = (() => {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { return JSON.parse(raw).default; } catch {} }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const db = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const ID_URL = "https://fkiokwwztbyztleeuwks.supabase.co";
const DEFAULT_ORIGIN = "https://support.favorites.alqurmanix.com";
const ADMIN_URL = "https://support.favorites.alqurmanix.com/admin.html";

class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
function cors(req: Request) {
  const origin = req.headers.get("origin") || DEFAULT_ORIGIN;
  let allowed = false;
  try {
    const u = new URL(origin);
    allowed = u.protocol === "https:" && (u.hostname === "alqurmanix.com" || u.hostname.endsWith(".alqurmanix.com")) && !u.port;
  } catch {}
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-aqx-session",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin"
  };
}
const out = (req: Request, data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" }
});
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const hash = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const randomToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const clean = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function resolveAccount(req: Request): Promise<string | null> {
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return null;
  const session = req.headers.get("x-aqx-session") || "";
  if (session.length < 30) throw new ApiError("AQX_SESSION_REQUIRED", 401);
  const response = await fetch(ID_URL + "/functions/v1/aqx-favorites-auth/verify", {
    method: "POST",
    headers: { Authorization: authorization, "x-aqx-session": session, Origin: req.headers.get("origin") || "https://favorites.alqurmanix.com", "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10000)
  });
  const state = await response.json().catch(() => ({}));
  if (!response.ok || state.valid !== true || typeof state.user_id !== "string") throw new ApiError("AQX_SESSION_INVALID", 401);
  return state.user_id;
}

async function requireCentralAdmin(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new ApiError("ADMIN_SESSION_REQUIRED", 401);
  const response = await fetch(ID_URL + "/functions/v1/aqx-central-admin/v1/session/check", {
    method: "POST",
    headers: {
      "apikey": "sb_publishable_4DCXObCqPUoNnI8ANOo8dA_nRAg0y5_",
      "Authorization": authorization,
      "Content-Type": "application/json"
    },
    body: "{}",
    signal: AbortSignal.timeout(10000)
  }).catch(() => { throw new ApiError("CENTRAL_ADMIN_UNAVAILABLE", 503); });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true || result.allowed !== true) {
    throw new ApiError(response.status === 401 ? "ADMIN_SESSION_INVALID" : response.status === 403 ? "ADMIN_NOT_AUTHORIZED" : "CENTRAL_ADMIN_UNAVAILABLE", response.status === 401 || response.status === 403 ? response.status : 503);
  }
  return result.admin || {};
}

async function sendTelegram(message: string) {
  const token = Deno.env.get("AQX_REVIEW_TELEGRAM_BOT_TOKEN") || Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const chatId = Deno.env.get("AQX_REVIEW_TELEGRAM_CHAT_ID") || Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!token || !chatId) return "not_configured";
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && result.ok === true ? "sent" : "failed";
  } catch { return "failed"; }
}

async function sendEmail(to: string, subject: string, text: string) {
  if (!emailPattern.test(to)) return "not_configured";
  const { data: bridgeToken, error: bridgeError } = await db.rpc("aqx_notifications_get_email_bridge_token");
  if (bridgeError || typeof bridgeToken !== "string" || bridgeToken.length !== 64) return "not_configured";
  try {
    const response = await fetch(ID_URL + "/functions/v1/aqx-notifications-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aqx-notifications-bridge": bridgeToken },
      body: JSON.stringify({
        job_id: crypto.randomUUID(), email: to, title: subject.slice(0,180),
        body: text.slice(0,2800), target_path: "/notifications"
      }),
      signal: AbortSignal.timeout(12000)
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && result?.ok === true && typeof result?.provider_message_id === "string" ? "sent" : "failed";
  } catch { return "failed"; }
}


async function generateSupportReply(input: { name: string; category: string; subject: string; details: string; pageUrl: string }) {
  const fallbackReply = () => {
    const category = input.category.toLowerCase();
    let guidance = "جرّب تحديث الصفحة ثم إعادة المحاولة، ودوّن وقت ظهور المشكلة وأي رسالة خطأ كما ظهرت.";
    if (/account|حساب/.test(category)) guidance = "تأكد من استخدام وسيلة الدخول المرتبطة بحسابك، ولا تشارك كلمة المرور أو رموز التحقق مع أي شخص.";
    else if (/saving|حفظ/.test(category)) guidance = "لا تحذف بيانات التطبيق أو المتصفح قبل التأكد من مزامنة محفوظاتك. جرّب إعادة تحميل الصفحة وتحقق من ظهور العنصر في المكتبة مرة أخرى.";
    else if (/sync|مزامنة/.test(category)) guidance = "تحقق من اتصال الإنترنت، وافتح AQX Favorites من جديد، وانتظر اكتمال المزامنة قبل تكرار العملية.";
    else if (/display|عرض/.test(category)) guidance = "أعد تحميل الصفحة، وتحقق من إعدادات تكبير المتصفح، ثم جرّب فتح الصفحة في تبويب جديد.";
    else if (/performance|أداء/.test(category)) guidance = "أعد تحميل الصفحة وأغلق التبويبات غير الضرورية، ثم جرّب مرة أخرى مع تسجيل نوع الجهاز والمتصفح.";
    else if (/search|بحث/.test(category)) guidance = "جرّب كلمة بحث أقصر أو عبارة مميزة من العنوان، وتأكد من إزالة أي مسافات زائدة.";
    else if (/reviews|مراجع|تقييم/.test(category)) guidance = "تحقق من اتصال الإنترنت ثم أعد فتح صفحة التقييم. احتفظ بنص المراجعة قبل إعادة الإرسال لتجنب فقدانه.";
    else if (/security|أمان/.test(category)) guidance = "لا تشارك كلمة المرور أو رموز التحقق أو روابط استعادة الحساب. إذا لاحظت نشاطًا غير معتاد، أمّن بريدك المرتبط بالحساب أولًا.";
    else if (/notifications|إشعار/.test(category)) guidance = "راجع إعدادات الإشعارات في الجهاز والمتصفح، وتأكد من السماح بالإشعارات للموقع.";
    else if (/other|أخرى/.test(category)) guidance = "أرسل لفريق الدعم نص رسالة الخطأ والخطوات التي سبقت ظهور المشكلة، مع نوع الجهاز والمتصفح إن أمكن.";
    return "أهلًا " + input.name + "، شكرًا لإرسال بلاغك بعنوان: «" + input.subject + "».\n\n" +
      "تم استلام البلاغ وحفظ تفاصيله، وهذا رد آلي أولي لمساعدتك:\n" + guidance + "\n\n" +
      "إذا استمرت المشكلة، لا تكرر إرسال البلاغ؛ سيظل البلاغ المسجل متاحًا لفريق دعم AQX لمراجعته. يمكنك متابعة أي تحديث من صفحة متابعة البلاغ.\n\n" +
      "تنبيه أمني: لا ترسل كلمات مرور أو رموز تحقق أو مفاتيح سرية.";
  };
  const apiKey = Deno.env.get("AQX_TTS_API_KEY") || "";
  if (!apiKey) return { ok: true as const, answer: fallbackReply(), model: "aqx-support-automatic-fallback", fallback: true };
  const base = (Deno.env.get("AQX_TTS_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers = { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" };
  let model = Deno.env.get("AQX_SUPPORT_AI_MODEL") || Deno.env.get("AQX_CHAT_MODEL") || "";
  if (!model) {
    try {
      const modelsResponse = await fetch(base + "/models", { headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(7000) });
      if (modelsResponse.ok) {
        const catalog = await modelsResponse.json().catch(() => ({}));
        const models = Array.isArray(catalog.data) ? catalog.data.map((x: any) => String(x.id || "")) : [];
        model = models.find((id: string) => id && !/(tts|transcri|whisper|embedding|audio|speech|moderation|image|realtime)/i.test(id)) || "";
      }
    } catch {}
  }
  if (!model) model = "gpt-4o-mini";
  const system = [
    "أنت مساعد الدعم الفني الرسمي لمنصة AQX Favorites.",
    "أجب باللغة العربية الواضحة وبأسلوب مهني ودود ومختصر.",
    "حلل المشكلة المذكورة فقط، وقدّم خطوات عملية آمنة ومحددة.",
    "لا تدّعِ أنك نفذت إصلاحًا أو غيّرت بيانات أو راجعت حسابًا.",
    "لا تطلب كلمات مرور أو رموز تحقق أو مفاتيح سرية.",
    "إذا كانت المعلومات غير كافية، وضّح ما يلزم للتحقق وصعّد الحالة لفريق الدعم.",
    "لا تخترع روابط أو خصائص غير مؤكدة. لا تذكر أنك نموذج ذكاء اصطناعي."
  ].join("\n");
  const user = [
    "اسم المبلّغ: " + input.name,
    "التصنيف: " + input.category,
    "عنوان البلاغ: " + input.subject,
    "التفاصيل: " + input.details,
    "رابط الصفحة: " + (input.pageUrl || "غير محدد"),
    "اكتب ردًا مباشرًا للمستخدم يتضمن التشخيص الأولي والخطوة التالية."
  ].join("\n");
  try {
    const response = await fetch(base + "/chat/completions", {
      method: "POST", headers,
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2, max_tokens: 650 }),
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let providerError: any = {};
      try { providerError = JSON.parse(errorBody)?.error || {}; } catch {}
      console.error("support_ai_provider_error", JSON.stringify({
        status: response.status,
        type: String(providerError.type || "").slice(0, 80),
        code: String(providerError.code || "").slice(0, 100),
        message: String(providerError.message || errorBody || "No provider error body").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500),
        base_host: new URL(base).host,
        model
      }));
      return { ok: true as const, answer: fallbackReply(), model: "aqx-support-automatic-fallback", fallback: true, provider_error: response.status };
    }
    const result = await response.json().catch(() => ({}));
    const raw = result?.choices?.[0]?.message?.content;
    const answer = typeof raw === "string" ? raw.trim() : Array.isArray(raw) ? raw.map((x: any) => typeof x?.text === "string" ? x.text : "").join("\n").trim() : "";
    if (answer.length < 20) return { ok: true as const, answer: fallbackReply(), model: "aqx-support-automatic-fallback", fallback: true };
    return { ok: true as const, answer: answer.slice(0, 9000), model, fallback: false };
  } catch (error) {
    console.error("support_ai_request_error", error instanceof Error ? error.name : "unknown");
    return { ok: true as const, answer: fallbackReply(), model: "aqx-support-automatic-fallback", fallback: true };
  }
}
async function getTicketByAccess(ticketNumber: string, trackingToken: string) {
  if (!ticketNumber || trackingToken.length < 24) throw new ApiError("TRACKING_DETAILS_REQUIRED", 400);
  const { data, error } = await db.from("aqx_favorites_support_tickets").select("id,ticket_number,reporter_name,category,custom_category,subject,details,page_url,status,ai_status,created_at,updated_at,last_replied_at")
    .eq("ticket_number", ticketNumber).eq("tracking_token_hash", await hash(trackingToken)).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError("TICKET_NOT_FOUND_OR_ACCESS_DENIED", 404);
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && (path.endsWith("/health") || path === "/")) {
      return out(req, { ok: true, service: "aqx-favorites-support", status: "active" });
    }

    if (req.method === "POST" && path.endsWith("/submit")) {
      const body = await req.json().catch(() => ({}));
      if (clean(body.website, 200)) throw new ApiError("INVALID_SUBMISSION", 400);
      const category = clean(body.category, 60);
      const subject = clean(body.subject, 180);
      const details = clean(body.details, 8000);
      const contact = clean(body.contact, 240);
      const customCategory = clean(body.other_category, 100);
      const pageUrl = clean(body.page_url, 2048);
      const allowed = ["account","saving","sync","display","performance","search","reviews","security","notifications","other"];
      if (!allowed.includes(category) || (category === "other" && !customCategory)) throw new ApiError("INVALID_CATEGORY", 400);
      if (subject.length < 4 || details.length < 12) throw new ApiError("REPORT_DETAILS_TOO_SHORT", 400);
      if (pageUrl && !/^https:\/\//i.test(pageUrl)) throw new ApiError("INVALID_PAGE_URL", 400);
      const forwarded = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
      const ip = forwarded.split(",")[0].trim().toLowerCase() || "unknown";
      const ipHash = await hash((Deno.env.get("AQX_FAVORITES_RATE_SALT") || KEY) + "|support-ticket|" + ip);
      const rate = await db.rpc("aqx_favorites_consume_rate_limit", { p_key_hash_hex: ipHash, p_limit: 5, p_window_seconds: 3600 });
      if (rate.error) throw rate.error;
      if (rate.data !== true) throw new ApiError("TOO_MANY_REPORTS_TRY_LATER", 429);
      const reporterUserId = await resolveAccount(req);
      const trackingToken = randomToken();
      const ticketNumber = "AQXF-" + new Date().toISOString().slice(2,10).replace(/-/g,"") + "-" + Array.from(crypto.getRandomValues(new Uint8Array(4)),x=>x.toString(16).padStart(2,"0")).join("").toUpperCase();
      const { data: ticket, error } = await db.from("aqx_favorites_support_tickets").insert({
        ticket_number: ticketNumber, tracking_token_hash: await hash(trackingToken), reporter_user_id: reporterUserId,
        reporter_name: clean(body.name, 120) || "مستخدم AQX Favorites", reply_contact: contact || null,
        subject, category, custom_category: category === "other" ? customCategory : null, details, page_url: pageUrl || null,
        ai_status: "not_configured", ai_failure_reason: null
      }).select("id,ticket_number,created_at").single();
      if (error) throw error;

      const aiResult = await generateSupportReply({
        name: clean(body.name, 120) || "مستخدم AQX Favorites",
        category: category === "other" ? "أخرى — " + customCategory : category,
        subject, details, pageUrl
      });
      let autoResponse: { status: string; reason?: string; reply_id?: string } = { status: "escalated", reason: "AQX_AI_PROVIDER_UNAVAILABLE" };
      if (aiResult.ok) {
        const { data: aiReply, error: aiReplyError } = await db.from("aqx_favorites_support_replies").insert({
          ticket_id: ticket.id, author_type: "system", author_label: aiResult.fallback ? "الرد الآلي الأولي من AQX Support" : "مساعد AQX الذكي",
          body: aiResult.answer, visibility: "public"
        }).select("id,body,created_at").single();
        if (!aiReplyError && aiReply) {
          const { error: aiUpdateError } = await db.from("aqx_favorites_support_tickets").update({
            ai_status: "answered", ai_failure_reason: null, status: "answered",
            last_replied_at: aiReply.created_at, updated_at: new Date().toISOString()
          }).eq("id", ticket.id);
          if (!aiUpdateError) autoResponse = { status: "answered", reply_id: aiReply.id };
          else autoResponse = { status: "escalated", reason: "AQX_AI_REPLY_STATUS_UPDATE_FAILED" };
        } else {
          autoResponse = { status: "escalated", reason: "AQX_AI_REPLY_SAVE_FAILED" };
        }
      } else {
        autoResponse = { status: "escalated", reason: aiResult.reason };
      }
      if (autoResponse.status !== "answered") {
        await db.from("aqx_favorites_support_tickets").update({
          ai_status: "failed", ai_failure_reason: autoResponse.reason,
          updated_at: new Date().toISOString()
        }).eq("id", ticket.id);
      }

      const adminSettings = await db.from("aqx_settings").select("favorites_support_admin_email").eq("settings_id","global").maybeSingle();
      const adminEmail = adminSettings.data?.favorites_support_admin_email || "alqurmanix@gmail.com";
      const message = [
        "بلاغ دعم فني جديد — AQX Favorites",
        "رقم البلاغ: " + ticketNumber,
        "نوع المشكلة: " + (category === "other" ? "أخرى — " + customCategory : category),
        "العنوان: " + subject,
        "التفاصيل: " + details,
        "وسيلة الرد: " + (contact || "غير متوفرة"),
        "رابط الصفحة: " + (pageUrl || "غير محدد"),
        autoResponse.status === "answered" ? "حالة الرد الآلي: تم إنشاء رد AI ونشره للمستخدم." : "حالة الرد الآلي: تعذر إنشاء رد AI، ويلزم تدخل فريق الدعم.",
        "إدارة البلاغات: " + ADMIN_URL
      ].join("\n");
      const [telegramStatus, emailStatus] = await Promise.all([
        sendTelegram(message),
        sendEmail(adminEmail, "بلاغ دعم جديد " + ticketNumber + " — AQX Favorites", message)
      ]);
      await db.from("aqx_favorites_support_tickets").update({
        telegram_status: telegramStatus, admin_email_status: emailStatus,
        updated_at: new Date().toISOString()
      }).eq("id", ticket.id);

      return out(req, {
        ok: true, ticket_number: ticketNumber, tracking_token: trackingToken,
        created_at: ticket.created_at, message: "تم إرسال بلاغك بنجاح.",
        delivery: { telegram: telegramStatus, admin_email: emailStatus },
        auto_response: autoResponse
      }, 201);
    }

    if (req.method === "POST" && path.endsWith("/track")) {
      const body = await req.json().catch(() => ({}));
      const ticket = await getTicketByAccess(clean(body.ticket_number, 40), clean(body.tracking_token, 120));
      const { data: replies, error } = await db.from("aqx_favorites_support_replies").select("id,author_label,body,created_at")
        .eq("ticket_id", ticket.id).eq("visibility","public").order("created_at",{ascending:true});
      if (error) throw error;
      return out(req, { ok: true, ticket, replies: replies || [] });
    }

    if (req.method === "POST" && path.endsWith("/admin/list")) {
      await requireCentralAdmin(req);
      const body = await req.json().catch(() => ({}));
      const limit = Math.min(100, Math.max(1, Number.isInteger(body.limit) ? body.limit : 50));
      const { data, error, count } = await db.from("aqx_favorites_support_tickets").select("id,ticket_number,reporter_name,reply_contact,category,custom_category,subject,status,ai_status,telegram_status,admin_email_status,created_at,last_replied_at",{count:"exact"})
        .order("created_at",{ascending:false}).range(0,limit-1);
      if (error) throw error;
      return out(req, { ok: true, tickets: data || [], total: count || 0 });
    }

    const ticketId = path.match(/\/admin\/ticket\/([0-9a-f-]{36})$/i)?.[1];
    if (req.method === "GET" && ticketId) {
      await requireCentralAdmin(req);
      const { data: ticket, error } = await db.from("aqx_favorites_support_tickets").select("*").eq("id",ticketId).maybeSingle();
      if (error) throw error;
      if (!ticket) throw new ApiError("TICKET_NOT_FOUND",404);
      const { data: replies, error: re } = await db.from("aqx_favorites_support_replies").select("*").eq("ticket_id",ticketId).order("created_at",{ascending:true});
      if (re) throw re;
      return out(req,{ok:true,ticket,replies:replies||[]});
    }

    const replyId = path.match(/\/admin\/reply\/([0-9a-f-]{36})$/i)?.[1];
    if (req.method === "POST" && replyId) {
      const admin = await requireCentralAdmin(req);
      const body = await req.json().catch(() => ({}));
      const reply = clean(body.reply,10000);
      if (reply.length < 2) throw new ApiError("REPLY_REQUIRED",400);
      const { data: ticket, error: te } = await db.from("aqx_favorites_support_tickets").select("id,ticket_number,reporter_user_id,reply_contact").eq("id",replyId).maybeSingle();
      if (te) throw te;
      if (!ticket) throw new ApiError("TICKET_NOT_FOUND",404);
      const { data: savedReply, error: re } = await db.from("aqx_favorites_support_replies").insert({
        ticket_id: replyId, author_type:"admin", author_label:clean(admin.name || admin.email,100) || "فريق دعم AQX", body:reply, visibility:"public"
      }).select("id,body,created_at").single();
      if (re) throw re;
      const { error: ue } = await db.from("aqx_favorites_support_tickets").update({
        status:"answered", last_replied_at:savedReply.created_at, updated_at:new Date().toISOString()
      }).eq("id",replyId);
      if (ue) throw ue;

      let inApp = "not_applicable", userEmail = "not_applicable";
      if (ticket.reporter_user_id) {
        try {
          const { error: ne } = await db.rpc("aqx_notifications_emit", {
            p_event_key:"favorites-support-reply-" + savedReply.id,
            p_event_type:"support_ticket_reply",
            p_platform:"favorites",
            p_recipient_user_id:ticket.reporter_user_id,
            p_title:"رد جديد من فريق AQX Favorites",
            p_body:"تمت إضافة رد جديد على البلاغ " + ticket.ticket_number,
            p_target_path:"/guest/?support_ticket=" + encodeURIComponent(ticket.ticket_number),
            p_scope:"platform",
            p_payload:{ticket_number:ticket.ticket_number,reply_id:savedReply.id}
          });
          inApp = ne ? "failed" : "queued";
        } catch { inApp = "failed"; }
      }
      if (ticket.reply_contact && emailPattern.test(ticket.reply_contact)) {
        userEmail = await sendEmail(ticket.reply_contact,"رد فريق AQX Favorites على البلاغ " + ticket.ticket_number,reply + "\n\nرقم البلاغ: " + ticket.ticket_number);
      }
      return out(req,{ok:true,reply:savedReply,delivery:{in_app:inApp,email:userEmail}});
    }

    throw new ApiError("NOT_FOUND",404);
  } catch (error) {
    if (error instanceof ApiError) return out(req,{ok:false,error:error.message},error.status);
    console.error("AQX Favorites Support error",error);
    return out(req,{ok:false,error:"INTERNAL_ERROR"},500);
  }
});
