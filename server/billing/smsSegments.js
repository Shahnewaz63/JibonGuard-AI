const GSM_BASIC = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const GSM_EXTENSION = new Set(Array.from('\f^{}\\[]~|€'));

export function calculateSmsSegments(message) {
  const text = String(message ?? '');
  let gsmUnits = 0;
  for (const character of text) {
    if (GSM_BASIC.has(character)) gsmUnits += 1;
    else if (GSM_EXTENSION.has(character)) gsmUnits += 2;
    else {
      const units = Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) > 0xffff ? 2 : 1), 0);
      const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
      return { encoding: 'UCS-2', units, segments };
    }
  }
  return { encoding: 'GSM-7', units: gsmUnits, segments: gsmUnits === 0 ? 0 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153) };
}
