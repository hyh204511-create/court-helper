function fallback(now) {
  const value = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return `report-${value.toISOString().slice(0, 10)}.xlsx`;
}

export function sanitizeReportFileName(label, now = new Date()) {
  const base = String(label ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const filtered = [...base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")]
    .filter((value) => /[\p{L}\p{N}_.\-（）]/u.test(value))
    .join("")
    .replace(/\.xlsx$/iu, "");
  if (!/[\p{L}\p{N}]/u.test(filtered)) return fallback(now);
  return `${filtered.slice(0, 195)}.xlsx`;
}
