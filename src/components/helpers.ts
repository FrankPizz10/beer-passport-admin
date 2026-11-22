export function fmtDate(value: string | null | undefined): string {
  if (!value) return "None";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function fmtBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "None";
  return value ? "Yes" : "No";
}

export function fmtVal(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  return String(value);
}

export function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}
