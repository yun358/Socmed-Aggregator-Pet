/**
 * Instagram's web JSON read into posts. Two shapes carry posts: the profile payload's GraphQL
 * nodes (`shortcode`, `edge_media_to_caption`) and the media objects of tag, search and feed
 * payloads (`code`, `caption.text`, `media_type` 1 image, 2 video, 8 carousel).
 */
import { clean, type ImageRef, type Post } from '../posts.ts';

const ORIGIN = 'https://www.instagram.com';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const best = (versions: unknown): string => {
  const c = isObj(versions) && Array.isArray(versions.candidates) ? versions.candidates.find(isObj) : undefined;
  return c ? str(c.url) : '';
};

function fromMedia(m: Json): Post | null {
  const code = str(m.code);
  if (!code) return null;
  const type = num(m.media_type);
  const children = Array.isArray(m.carousel_media) ? m.carousel_media.filter(isObj) : [];
  const parts = children.length ? children : [m];
  const images: ImageRef[] = parts.filter((p) => num(p.media_type) !== 2)
    .map((p) => ({ url: best(p.image_versions2), alt: str(p.accessibility_caption) }))
    .filter((i) => i.url)
    .map((i) => (i.alt ? i : { url: i.url }));
  const user = isObj(m.user) ? m.user : {};
  const caption = isObj(m.caption) ? str(m.caption.text) : '';
  const taken = num(m.taken_at);
  const stats: Post['stats'] = [];
  if (num(m.like_count) !== undefined) stats.push(['likes', String(m.like_count)]);
  if (num(m.comment_count) !== undefined) stats.push(['comments', String(m.comment_count)]);
  return {
    platform: 'instagram',
    id: code,
    url: `${ORIGIN}/p/${code}/`,
    author: str(user.username) || undefined,
    text: clean(caption),
    publishedAt: taken ? new Date(taken * 1000).toISOString() : undefined,
    stats,
    images,
    video: type === 2 || (children.length > 0 && children.every((c) => num(c.media_type) === 2)),
    extraction: 'adapter',
  };
}

function fromNode(n: Json, owner: string): Post | null {
  const code = str(n.shortcode);
  if (!code) return null;
  const captionEdges = isObj(n.edge_media_to_caption) && Array.isArray(n.edge_media_to_caption.edges) ? n.edge_media_to_caption.edges : [];
  const caption = captionEdges.length && isObj(captionEdges[0]) && isObj(captionEdges[0].node) ? str(captionEdges[0].node.text) : '';
  const childEdges = isObj(n.edge_sidecar_to_children) && Array.isArray(n.edge_sidecar_to_children.edges) ? n.edge_sidecar_to_children.edges : [];
  const parts = childEdges.length ? childEdges.filter(isObj).map((e) => (isObj(e.node) ? e.node : {})) : [n];
  const images: ImageRef[] = parts.filter((p) => p.is_video !== true && str(p.display_url))
    .map((p) => (str(p.accessibility_caption) ? { url: str(p.display_url), alt: str(p.accessibility_caption) } : { url: str(p.display_url) }));
  const likes = isObj(n.edge_liked_by) ? num(n.edge_liked_by.count) : isObj(n.edge_media_preview_like) ? num(n.edge_media_preview_like.count) : undefined;
  const comments = isObj(n.edge_media_to_comment) ? num(n.edge_media_to_comment.count) : undefined;
  const taken = num(n.taken_at_timestamp);
  const stats: Post['stats'] = [];
  if (likes !== undefined) stats.push(['likes', String(likes)]);
  if (comments !== undefined) stats.push(['comments', String(comments)]);
  return {
    platform: 'instagram',
    id: code,
    url: `${ORIGIN}/p/${code}/`,
    author: owner || undefined,
    text: clean(caption),
    publishedAt: taken ? new Date(taken * 1000).toISOString() : undefined,
    stats,
    images,
    video: !images.length && parts.some((p) => p.is_video === true),
    extraction: 'adapter',
  };
}

/** Every post in a payload, in order, each once. */
export function parseInstagramPosts(json: unknown): Post[] {
  const out: Post[] = [];
  const seen = new Set<string>();
  const add = (p: Post | null) => { if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); } };
  const owner = isObj(json) && isObj(json.data) && isObj(json.data.user) ? str(json.data.user.username) : '';
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!isObj(v)) return;
    if (typeof v.code === 'string' && (v.media_type !== undefined || v.caption !== undefined)) { add(fromMedia(v)); return; }
    if (typeof v.shortcode === 'string' && (v.display_url !== undefined || v.edge_media_to_caption !== undefined)) { add(fromNode(v, owner)); return; }
    for (const x of Object.values(v)) walk(x);
  };
  walk(json);
  return out;
}
