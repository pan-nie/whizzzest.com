export const GALLERY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const GALLERY_PREFIX = 'gallery/';

export function galleryKey(id, token, variant) {
  return `${GALLERY_PREFIX}${id}/${token}/${variant}.jpg`;
}

export async function galleryImage(request, bucket, photo, variant) {
  if (!photo) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const key = galleryKey(photo.id, photo.image_token, variant);
  const head = request.method === 'HEAD';
  const object = head ? await bucket.head(key) : await bucket.get(key);
  if (!object) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(head ? null : object.body, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(object.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
