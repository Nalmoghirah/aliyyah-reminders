/**
 * العليّة — automatic notifications (runs on GitHub every 5 minutes, Riyadh time).
 *  1) An admin adds an آل علي meeting or a named event at the farm → heads-up to everyone (once per event).
 *  2) From 12:00 noon on the day → a reminder (once per day): who hasn't replied is asked to reply,
 *     who said they're coming gets a welcome, who apologised gets nothing.
 *  3) An event people were told about is cancelled → everyone is told it's off (or back in Riyadh).
 *  4) An admin writes a message on the site (bell → أرسل تنبيه للكل) → it goes to everyone.
 *  Manual test: run the workflow by hand with a name → a test notification to that person only; type الكل → to everyone.
 * Needs the secret FIREBASE_SERVICE_ACCOUNT (the service-account JSON from Firebase).
 */
const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const SITE = "https://al-aliyyah-farm.web.app/";
const TZ = "Asia/Riyadh";
const REMIND_HOUR = 12;
const TEST_NAME = (process.env.TEST_NAME || "").trim();

function riyadhNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const evName = (m) => (m.kind === "custom" ? (m.title || "مناسبة") : "اجتماع آل علي");
// "الجمعة ٢٣ أكتوبر"
function longDate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-arab", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, mo - 1, d, 12))).replace("،", "");
}
// "اليوم" / "بكرة" / "يوم الجمعة ٢٣ أكتوبر"
function whenText(iso, today) {
  const diff = Math.round((Date.parse(iso) - Date.parse(today)) / 864e5);
  if (diff === 0) return "اليوم";
  if (diff === 1) return "بكرة";
  return "يوم " + longDate(iso);
}
const ar = (n) => Number(n).toLocaleString("ar-SA");
const norm = (n) => String(n || "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";

/** Sends to every registered device. `make(device)` returns {title, body} or null to skip that device. */
async function send(tag, make, onlyName) {
  const snap = await db.collection("pushTokens").get();
  let docs = snap.docs;
  if (onlyName) docs = docs.filter((d) => norm(d.get("name")) === norm(onlyName));
  const msgs = [];
  for (const d of docs) {
    const note = make({ name: d.get("name") || "", device: d.get("device") || "" });
    if (!note) continue;
    msgs.push({
      token: d.id,
      notification: { title: note.title, body: note.body },
      webpush: {
        notification: { title: note.title, body: note.body, icon: SITE + "icon-192.png", badge: SITE + "icon-192.png", dir: "rtl", lang: "ar", tag, renotify: true },
        fcmOptions: { link: note.link || SITE + "#friday" },
      },
    });
  }
  if (!msgs.length) { console.log("nobody to send to", tag, onlyName || ""); return; }
  let ok = 0, bad = 0;
  for (let i = 0; i < msgs.length; i += 500) {
    const batch = msgs.slice(i, i + 500);
    const res = await admin.messaging().sendEach(batch);
    ok += res.successCount; bad += res.failureCount;
    await Promise.all(res.responses.map((r, k) => {
      const code = r.error && r.error.code;
      if (code) console.log("fail", code);
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument")
        return db.collection("pushTokens").doc(batch[k].token).delete().catch(() => {});
      return null;
    }));
  }
  console.log(`sent ${tag} ok=${ok} failed=${bad}`);
}

(async () => {
  if (TEST_NAME) {
    const everyone = ["الكل", "الجميع", "all"].includes(norm(TEST_NAME).toLowerCase());
    await send("test", (u) => ({ title: "تجربة من العليّة 🌴", body: `هلا${firstName(u.name) ? " " + firstName(u.name) : ""}، هذي رسالة تجربة. التنبيهات شغّالة عندك تمام.`, link: SITE }), everyone ? "" : TEST_NAME);
    return;
  }
  // only one run at a time (cron-job.org every 2 min + GitHub's own schedule can overlap) → no double notifications
  const lock = db.collection("locks").doc("runner");
  const me = Math.random().toString(36).slice(2);
  const got = await db.runTransaction(async (tx) => {
    const l = await tx.get(lock);
    if (l.exists && Date.now() - (l.get("t") || 0) < 4 * 60000) return false;
    tx.set(lock, { t: Date.now(), by: me });
    return true;
  });
  if (!got) { console.log("another run is busy, skipping"); return; }

  const now = riyadhNow();
  console.log("Riyadh", now);

  // ---- 0) admin messages from the site (broadcasts with status "pending")
  const bc = await db.collection("broadcasts").where("status", "==", "pending").get();
  const pend = bc.docs.sort((x, y) => String(x.get("at")).localeCompare(String(y.get("at"))));
  let sentNow = 0;
  for (const d of pend) {
    const x = d.data();
    const ageMin = (Date.now() - Date.parse(x.at || 0)) / 60000;
    if (!(ageMin < 120) || sentNow >= 3) { // too old, or too many at once → don't flood phones
      await d.ref.update({ status: "skipped", doneAt: new Date().toISOString() });
      continue;
    }
    const title = String(x.title || "تنبيه من العليّة 🌴").slice(0, 60);
    const body = String(x.body || "").slice(0, 200);
    if (!body) { await d.ref.update({ status: "skipped" }); continue; }
    await send("bc-" + d.id, () => ({ title, body, link: SITE }));
    await d.ref.update({ status: "sent", doneAt: new Date().toISOString() });
    sentNow++;
  }

  // ---- 3) cancellations (the site leaves a note in "cancelled" when an announced event is removed)
  const cancels = await db.collection("cancelled").get();
  for (const c of cancels.docs) {
    const day = c.id, x = c.data();
    const backOn = (await db.collection("meetings").doc(day).get()).exists; // re-set since → don't announce a cancel
    if (day >= now.date && !backOn) {
      const when = whenText(day, now.date);
      const note = x.back
        ? { title: "تغيير: اجتماع آل علي بالرياض", body: `اجتماع ${when} صار بالرياض مثل العادة، مو بالعليّة.` }
        : { title: `انلغى ${evName(x)} ❌`, body: `${evName(x)} ${when} بالعليّة انلغى. نشوفكم على خير.` };
      await send("ev-" + day, () => note);
    }
    await c.ref.delete();
  }

  // ---- 1) new events, 2) day-of reminders
  const snap = await db.collection("meetings").where(admin.firestore.FieldPath.documentId(), ">=", now.date).get();
  for (const doc of snap.docs) {
    const m = doc.data();
    if (m.location !== "farm") continue;
    const day = doc.id, name = evName(m);

    if (!m.notifiedNew) {
      if (day > now.date) {
        const when = whenText(day, now.date);
        await send("ev-" + day, () => ({
          title: `${name} بالعليّة 🌴`,
          body: m.kind === "custom"
            ? `${when} بالمزرعة، حيّاكم الله. علّمنا بتحضر؟`
            : `${when} الاجتماع بالمزرعة، حيّاكم الله. علّمنا بتحضر؟ وبتتعشى معنا؟`,
        }));
        await doc.ref.update({ notifiedNew: true, announced: true });
      } else {
        await doc.ref.update({ notifiedNew: true }); // set for today: the noon reminder covers it
      }
    }

    if (day === now.date && now.hour >= REMIND_HOUR && m.remindedOn !== day) {
      const rs = (await db.collection("rsvps").where("date", "==", day).get()).docs.map((d) => d.data());
      const yes = rs.filter((r) => r.attend === "yes").length;
      const byDevice = new Map(rs.map((r) => [r.device, r]));
      const byName = new Map(rs.map((r) => [norm(r.name), r]));
      const title = `اليوم ${name} بالعليّة 🌴`;
      await send("ev-" + day, (u) => {
        const r = (u.device && byDevice.get(u.device)) || (u.name && byName.get(norm(u.name)));
        const fn = firstName(u.name);
        if (r && r.attend === "no") return null; // apologised — don't nag
        if (r) return {
          title,
          body: `حيّاك الله${fn ? " يا " + fn : ""}، ننتظرك${r.dinner === "yes" ? " وعشاك محسوب" : ""}.${yes > 1 ? ` وصرتوا ${ar(yes)} لين الحين.` : ""}`,
        };
        return {
          title,
          body: `${fn ? fn + "، " : ""}للحين ما علّمتنا. بتحضر؟ وبتتعشى؟${yes ? ` ${ar(yes)} أكّدوا لين الحين.` : ""}`,
        };
      });
      await doc.ref.update({ remindedOn: day, announced: true });
    }
  }
  await lock.delete().catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });
