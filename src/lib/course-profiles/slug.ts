export function buildCourseProfileSlug(input: {
  name: string;
  city: string;
  stateCode: string;
}) {
  return [input.name, input.city, input.stateCode]
    .map(slugPart)
    .filter(Boolean)
    .join("-")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

export function withStableSlugSuffix(slug: string, courseId: string) {
  return `${slug.slice(0, 113).replace(/-+$/g, "")}-${courseId.slice(-6).toLowerCase()}`;
}

function slugPart(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
