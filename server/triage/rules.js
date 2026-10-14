export const TRIAGE_LEVELS = Object.freeze(['DRINK_WATER_AND_REST', 'REST_AND_COOL', 'EMERGENCY_NOW']);

const redFlags = [
  ['unconscious', /\b(unconscious|passed out|fainted|fainting|collapse|collapsed|seizure|convulsion|not waking)\b|অজ্ঞান|মূর্ছা|খিঁচুনি|ঢলে পড়ে/i],
  ['confusion', /\b(confused|confusion|not making sense|strange speech|slurred speech|delirious)\b|বিভ্রান্ত|এলোমেলো কথা|অস্বাভাবিক কথা/i],
  ['hot_dry_skin', /\b(hot dry skin|stopped sweating|not sweating|no sweat)\b|শরীর গরম.*ঘাম নেই|ঘাম হচ্ছে না/i],
  ['severe_vomiting', /\b(severe|persistent|keeps?)\s+vomit(ing)?\b|বারবার বমি|অনবরত বমি/i],
  ['chest_pain', /\bchest pain\b|বুকে ব্যথা/i],
  ['breathing', /\b(trouble breathing|difficulty breathing|can't breathe|cannot breathe|shortness of breath)\b|shash\s*(koshto|kosto)|shash nite koshto|শ্বাসকষ্ট|শ্বাস নিতে কষ্ট/i],
  ['very_high_temperature', /\b(temperature|fever)\s*(of|is|:)?\s*(4[01]|40\s*°?c)\b|১০৪\s*°?ফ|৪০\s*°?সে/i],
];
const moderate = [
  ['headache', /\b(headache|head pain)\b|মাথাব্যথা|মাথা ব্যথা|matha betha/i],
  ['dizziness', /\b(dizzy|dizziness|lightheaded)\b|মাথা ঘোরা|matha ghora/i],
  ['cramps', /\b(cramp|cramps|muscle spasm)\b|পেশিতে টান|খিঁচুনি/i],
  ['heavy_sweating', /\b(heavy sweating|sweating a lot|sweat a lot)\b|প্রচুর ঘাম|অনেক ঘাম/i],
  ['nausea', /\b(nausea|nauseous)\b|বমি বমি|বমিভাব/i],
  ['weakness', /\b(weak|weakness|tired|exhausted)\b|দুর্বল|ক্লান্ত/i],
  ['thirst', /\b(thirsty|very thirsty)\b|তৃষ্ণা|পিপাসা/i],
];
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/\s+/g, ' ').trim();

export function classifySymptoms(text, heatCategory = 'Moderate') {
  const input = normalize(text);
  const hits = redFlags.filter(([, pattern]) => pattern.test(input)).map(([key]) => key);
  if (hits.length) return { severity: 'EMERGENCY_NOW', red_flags: hits, rule_hits: hits, classified: true };
  const symptoms = moderate.filter(([, pattern]) => pattern.test(input)).map(([key]) => key);
  if (!symptoms.length) return { severity: 'REST_AND_COOL', red_flags: [], rule_hits: [], classified: false };
  const severeHeat = ['high', 'extreme', 'very high'].includes(normalize(heatCategory));
  return { severity: severeHeat ? 'REST_AND_COOL' : 'DRINK_WATER_AND_REST', red_flags: [], rule_hits: symptoms, classified: true };
}

export function redactTriageText(text) {
  return String(text || '').normalize('NFKC')
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, '[number]')
    .replace(/\b(?:my name is|i am|this is)\s+[A-Z][\p{L}'-]{1,30}(?:\s+[A-Z][\p{L}'-]{1,30})?/giu, '[name]')
    .replace(/(?:আমার নাম|নাম)\s*[:：]??\s*[\p{L}]+(?:\s+[\p{L}]+)?/gu, '[name]')
    .replace(/[0-9০-৯]{3,}/g, '[digits]')
    .slice(0, 500);
}
