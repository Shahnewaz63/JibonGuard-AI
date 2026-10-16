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
    const recipientMap = new Map();
    for (const item of group.items) {
      if (!recipientMap.has(item.phone)) recipientMap.set(item.phone, { phone: item.phone, message: group.message, referenceIds: [] });
      if (item.id) recipientMap.get(item.phone).referenceIds.push(String(item.id));
    }
    const recipients = [...recipientMap.values()];
    const sms = await smsSender(recipients, group.message);
    results.push({ ...group, recipients, sms });
  }
  return results;
}
