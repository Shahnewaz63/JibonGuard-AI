export function groupAlertRecipients(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.channel}\0${item.message}`;
    if (!groups.has(key)) groups.set(key, { channel: item.channel, message: item.message, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export async function dispatchAlertGroups(items, { smsSender, voiceSender = async () => ({ accepted: false, error: 'Voice gateway is not configured.' }) }) {
  const results = [];
  for (const group of groupAlertRecipients(items)) {
    const recipients = [...new Map(group.items.map(item => [item.phone, { phone: item.phone, message: group.message }])).values()];
    let sms = { accepted: false }, voice = { accepted: false };
    if (group.channel === 'sms' || group.channel === 'sms+voice') sms = await smsSender(recipients, group.message);
    if (group.channel === 'voice' || group.channel === 'sms+voice') voice = await voiceSender(group.items, group.message);
    let smsFallback=false;
    if(group.channel==='voice'&&!voice.accepted){sms=await smsSender(recipients,group.message);smsFallback=sms.accepted;}
    results.push({ ...group, recipients, sms, voice, smsFallback });
  }
  return results;
}
