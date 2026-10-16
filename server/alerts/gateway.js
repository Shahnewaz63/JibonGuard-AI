export function groupAlertRecipients(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.channel}\0${item.message}`;
    if (!groups.has(key)) groups.set(key, { channel: item.channel, message: item.message, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export async function dispatchAlertGroups(items, { smsSender }) {
  const results = [];
  for (const group of groupAlertRecipients(items)) {
    const recipients = [...new Map(group.items.map(item => [item.phone, { phone: item.phone, message: group.message }])).values()];
    const sms = await smsSender(recipients, group.message);
    results.push({ ...group, recipients, sms });
  }
  return results;
}
