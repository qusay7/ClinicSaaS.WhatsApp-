import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import express from 'express'
import pino from 'pino'
import fs from 'fs'

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err))

const logger = pino({ level: 'silent' })

// ✅ جلسة مستقلة لكل عيادة — كل clinicId له socket و auth folder خاص به،
// عشان كل عيادة تربط رقم واتساب مختلف بدون ما تأثر على عيادة ثانية
const sessions = new Map() // clinicId -> { sock, status, qrDataUrl }

let cachedVersion = null
async function getVersion() {
  if (!cachedVersion) cachedVersion = (await fetchLatestBaileysVersion()).version
  return cachedVersion
}

async function startSession(rawClinicId) {
  // ✅ .NET يرسل الـ GUID بحروف صغيرة دايماً — نطبّع هنا عشان "start" بحروف كبيرة
  // (أو أي فرق حالة أحرف) ما يصير جلسة منفصلة عن نفس العيادة
  const clinicId = rawClinicId.toLowerCase()
  let session = sessions.get(clinicId)
  if (session && (session.status === 'open' || session.status === 'connecting')) return session

  const reconnectAttempts = session?.reconnectAttempts || 0
  session = { sock: null, status: 'connecting', qrDataUrl: null, phoneNumber: null, reconnectAttempts }
  sessions.set(clinicId, session)

  const { state, saveCreds } = await useMultiFileAuthState(`./auth_by_clinic/${clinicId}`)
  const version = await getVersion()

  const sock = makeWASocket({ auth: state, logger, version })
  session.sock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      session.status = 'qr'
      session.qrDataUrl = await qrcode.toDataURL(qr, { width: 800, margin: 3, errorCorrectionLevel: 'L' })
      console.log(`[${clinicId}] QR جديد — GET /clinics/${clinicId}/qr`)
    }

    if (connection === 'open') {
      session.status = 'open'
      session.qrDataUrl = null
      session.reconnectAttempts = 0
      // ✅ رقم الواتساب المتصل — sock.user.id بصيغة "9627xxxxxxx:xx@s.whatsapp.net"
      session.phoneNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null
      console.log(`[${clinicId}] ✅ متصل بواتساب (${session.phoneNumber || '?'})`)
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.log(`[${clinicId}] الاتصال انقطع (statusCode=${statusCode}):`, lastDisconnect?.error?.message || '')

      // ✅ تنظيف الـ socket القديم قبل أي إعادة محاولة — بدون هذا كان كل اتصال
      // فاشل يبقى معلّقاً بذاكرته ومستمعيه بدل أن يُجمَع كنفاية (GC)، وهذا
      // (مع غياب أي تأخير أدناه) هو ما تسبّب فعلياً بانهيار "out of memory"
      sock.ev.removeAllListeners()
      try { sock.end(undefined) } catch { /* الاتصال مقطوع أصلاً — تجاهل */ }

      if (loggedOut) {
        session.status = 'logged_out'
        session.phoneNumber = null
        session.reconnectAttempts = 0
        fs.rmSync(`./auth_by_clinic/${clinicId}`, { recursive: true, force: true })
      } else {
        session.status = 'reconnecting'
        session.reconnectAttempts = (session.reconnectAttempts || 0) + 1
        // ✅ تأخير متزايد (5ث، 10ث، ...) بسقف 60 ثانية بدل إعادة المحاولة
        // فوراً بلا توقف — هذا التأخير المفقود سابقاً كان يسمح بحلقة لا نهائية
        // من المحاولات الفورية عند انقطاع الشبكة/DNS، وهي التي استهلكت الذاكرة
        const delayMs = Math.min(5000 * session.reconnectAttempts, 60000)
        console.log(`[${clinicId}] إعادة المحاولة بعد ${delayMs / 1000} ثانية... (محاولة #${session.reconnectAttempts})`)
        setTimeout(() => startSession(clinicId), delayMs)
      }
    }
  })

  return session
}

const app = express()
app.use(express.json())

// ✅ يبدأ (أو يرجع) جلسة العيادة — أول استدعاء يفتح الاتصال ويولّد QR
app.post('/clinics/:clinicId/start', async (req, res) => {
  const session = await startSession(req.params.clinicId)
  res.json({ status: session.status })
})

app.get('/clinics/:clinicId/status', (req, res) => {
  const session = sessions.get(req.params.clinicId.toLowerCase())
  res.json({ status: session?.status || 'not_started', phoneNumber: session?.phoneNumber || null })
})

// ✅ نفس الحالة + QR (كـ data URL) بضربة واحدة — عشان الباك اند .NET يستهلكها
// بسهولة (JSON بس، بدون التعامل مع صورة ثنائية) ويعيد تمريرها للفرونت اند
app.get('/clinics/:clinicId/qr-data', (req, res) => {
  const session = sessions.get(req.params.clinicId.toLowerCase())
  res.json({ status: session?.status || 'not_started', qrDataUrl: session?.qrDataUrl || null, phoneNumber: session?.phoneNumber || null })
})

// ✅ يعرض QR كصورة مباشرة بالمتصفح — GET /clinics/clinic-1/qr
app.get('/clinics/:clinicId/qr', (req, res) => {
  const session = sessions.get(req.params.clinicId.toLowerCase())
  if (!session) return res.status(404).send('Session not started — POST /clinics/:clinicId/start first')
  if (session.status === 'open') return res.send('Already connected — no QR needed')
  if (!session.qrDataUrl) return res.status(202).send('QR not generated yet, retry in a second')

  const base64 = session.qrDataUrl.split(',')[1]
  res.set('Content-Type', 'image/png')
  res.send(Buffer.from(base64, 'base64'))
})

app.post('/clinics/:clinicId/send', async (req, res) => {
  const session = sessions.get(req.params.clinicId.toLowerCase())
  if (!session || session.status !== 'open') {
    return res.status(503).json({ error: 'Clinic WhatsApp session not connected', status: session?.status || 'not_started' })
  }

  const { phone, message } = req.body
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' })

  const digits = phone.replace(/\D/g, '').replace(/^00/, '')
  const jid = `${digits}@s.whatsapp.net`

  try {
    await session.sock.sendMessage(jid, { text: message })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ✅ عند تشغيل السيرفر، يعيد فتح جلسات العيادات اللي عندها auth محفوظ مسبقاً
async function restorePreviousSessions() {
  if (!fs.existsSync('./auth_by_clinic')) return
  for (const clinicId of fs.readdirSync('./auth_by_clinic')) {
    console.log(`استعادة جلسة العيادة: ${clinicId}`)
    await startSession(clinicId)
  }
}
restorePreviousSessions()

const PORT = 3001
app.listen(PORT, () => console.log(`\n📡 POC server listening on http://localhost:${PORT}`))
