export function publicAssetUrl(pathFromPublicRoot: string): string {
  const path = pathFromPublicRoot.replace(/^\/+/, '');
  return `${import.meta.env.BASE_URL}${path}`;
}
