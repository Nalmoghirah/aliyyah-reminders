/**
 * العليّة — automatic notifications (runs on GitHub every 30 minutes, Riyadh time).
 *  1) When an admin adds an آل علي meeting or a named event at the farm → heads-up to everyone (once per event).
 *  2) From 7:00 AM on the day of the meeting/event → reminder to RSVP (once per day).
 *  Manual test: run the workflow by hand with a name → a test notification goes only to that person's devices.
 * Needs the secret FIREBASE_SERVICE_ACCOUNT (the service-account JSON from Firebase).
 */
const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const SITE = "https://al-aliyyah-farm.web.app/";
const TZ = "Asia/Riyadh";
const REMIND_HOUR = 7;
const TEST_NAME = (process.env.TEST_NAME || "").trim();

function riyadhNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const title = (m) => (m.kind === "custom" ? (m.title || "مناسبة") : "اجتماع آل علي");
function longDate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-arab", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, mo - 1, d, 12)));
}
const norm = (n) => String(n || "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();

async function send(note, onlyName) {
  const snap = await db.collection("pushTokens").get();
  let docs = snap.docs;
  if (onlyName) docs = docs.filter((d) => norm(d.get("name")) === norm(onlyName));
  const tokens = docs.map((d) => d.id);
  if (!tokens.length) { console.log("no devices", onlyName || ""); return; }
  let ok = 0, bad = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: { title: note.title, body: note.body },
      webpush: {
        notification: { title: note.title, body: note.body, icon: SITE + "icon-192.png", badge: SITE + "icon-192.png", dir: "rtl", lang: "ar", tag: note.tag },
        fcmOptions: { link: note.link || SITE + "#friday" },
      },
    });
    ok += res.successCount; bad += res.failureCount;
    await Promise.all(res.responses.map((r, k) => {
      const code = r.error && r.error.code;
      if (code) console.log("fail", code);
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument")
        return db.collection("pushTokens").doc(batch[k]).delete().catch(() => {});
      return null;
    }));
  }
  console.log(`sent "${note.title}" ok=${ok} failed=${bad}`);
}

(async () => {
  if (TEST_NAME) {
    await send({ title: "تجربة من العليّة 🌴", body: `هلا ${TEST_NAME}! التنبيهات شغالة تمام.`, tag: "test", link: SITE }, TEST_NAME);
    return;
  }
  const now = riyadhNow();
  console.log("Riyadh", now);
  const snap = await db.collection("meetings").where(admin.firestore.FieldPath.documentId(), ">=", now.date).get();
  for (const doc of snap.docs) {
    const m = doc.data();
    if (m.location !== "farm") continue;
    const day = doc.id, name = title(m);
    if (!m.notifiedNew) {
      if (day > now.date) await send({ title: `${name} بالمزرعة 🌴`, body: `${longDate(day)} في العليّة. سجّل حضورك وهل بتتعشى.`, tag: "new-" + day });
      await doc.ref.update({ notifiedNew: true });
    }
    if (day === now.date && now.hour >= REMIND_HOUR && m.remindedOn !== day) {
      const yes = (await db.collection("rsvps").where("date", "==", day).where("attend", "==", "yes").get()).size;
      const body = yes ? `اليوم في العليّة، وفيه ${yes.toLocaleString("ar-SA")} مؤكدين. سجّل حضورك وهل بتتعشى.` : "اليوم في العليّة. سجّل حضورك وهل بتتعشى.";
      await send({ title: `تذكير: ${name} اليوم 🌴`, body, tag: "day-" + day });
      await doc.ref.update({ remindedOn: day });
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
