const CHANNEL_LABELS = {
  in_app: '羲和站内提醒',
  wecom_webhook: '企业微信群机器人',
}

export function configuredChannels() {
  return {
    in_app: { enabled: true, label: CHANNEL_LABELS.in_app },
    wecom_webhook: {
      enabled: Boolean(process.env.WECOM_BOT_WEBHOOK),
      label: CHANNEL_LABELS.wecom_webhook,
    },
  }
}

export function defaultReminderChannels() {
  return (process.env.DEFAULT_NOTIFICATION_CHANNELS || 'in_app')
    .split(',')
    .map(channel => channel.trim())
    .filter(Boolean)
}

export function reminderMessage(job) {
  const dayText = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(job.scheduled_at))
  return `羲和提醒：${job.name}的生日临近了（${dayText}）。可以提前准备一句祝福或一个小心意。`
}

async function sendInApp(job, message) {
  return {
    provider: 'in_app',
    providerMessageId: `local:${job.id}`,
    message,
  }
}

async function sendWeComWebhook(job, message) {
  const webhook = process.env.WECOM_BOT_WEBHOOK
  if (!webhook) throw new Error('WECOM_BOT_WEBHOOK_NOT_CONFIGURED')

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: message },
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.errcode !== 0) {
    throw new Error(`WECOM_WEBHOOK_FAILED:${body.errmsg || response.status}`)
  }
  return {
    provider: 'wecom_webhook',
    providerMessageId: body.msgid || `wecom:${job.id}`,
    message,
  }
}

export async function sendNotification(job) {
  const message = reminderMessage(job)
  if (job.channel === 'in_app') return sendInApp(job, message)
  if (job.channel === 'wecom_webhook') return sendWeComWebhook(job, message)
  throw new Error(`UNSUPPORTED_NOTIFICATION_CHANNEL:${job.channel}`)
}
