import { MongoClient, type Document } from "mongodb";
import type { Corpus, Entry, Lang } from "../types.ts";
import { looksLikeIdentifier, norm } from "../util/text.ts";

export type MongoOptions = {
  uri: string;
  db: string;
  sourceLang: Lang;
  projects?: string[];
  langs?: Lang[];
  limit?: number;
};

export async function loadFromMongo(opts: MongoOptions): Promise<Corpus> {
  const client = new MongoClient(opts.uri);
  try {
    await client.connect();
    const db = client.db(opts.db);

    const projectDocs = await db.collection("Projects").find({}, { projection: { name: 1, languages: 1 } }).toArray();
    const projectName = new Map<string, string>();
    const declaredLangs = new Set<Lang>();
    for (const p of projectDocs) {
      projectName.set(String(p._id), String(p.name ?? p._id));
      for (const l of (p.languages ?? []) as { iso?: string }[]) if (l.iso) declaredLangs.add(l.iso);
    }

    const wanted = opts.projects?.length
      ? projectDocs.filter((p) => opts.projects!.includes(String(p.name))).map((p) => p._id)
      : null;
    if (wanted && wanted.length === 0) {
      throw new Error(`no project matched ${opts.projects!.join(", ")}; available: ${[...projectName.values()].join(", ")}`);
    }

    const keyFilter: Document = { isArchived: { $ne: true } };
    if (wanted) keyFilter.projectId = { $in: wanted };

    const keyCursor = db.collection("Keys").find(keyFilter, {
      projection: { projectId: 1, keyName: 1, description: 1, context: 1, tags: 1 },
    });
    if (opts.limit) keyCursor.limit(opts.limit);
    const keyDocs = await keyCursor.toArray();
    const keyIds = keyDocs.map((k) => k._id);

    const trByKey = new Map<string, { tr: Record<Lang, string>; status: Record<Lang, string> }>();
    const seenLangs = new Set<Lang>();
    const trCursor = db
      .collection("Translations")
      .find({ keyId: { $in: keyIds } }, { projection: { keyId: 1, langIso: 1, value: 1, status: 1 } });
    for await (const t of trCursor) {
      const kid = String(t.keyId);
      let rec = trByKey.get(kid);
      if (!rec) trByKey.set(kid, (rec = { tr: {}, status: {} }));
      const iso = String(t.langIso);
      rec.tr[iso] = String(t.value ?? "");
      rec.status[iso] = String(t.status ?? "");
      seenLangs.add(iso);
    }

    const allLangs = [...(seenLangs.size ? seenLangs : declaredLangs)].sort();
    const langs = opts.langs?.length ? allLangs.filter((l) => opts.langs!.includes(l)) : allLangs;
    if (!langs.includes(opts.sourceLang)) langs.unshift(opts.sourceLang);

    const entries: Entry[] = [];
    for (const k of keyDocs) {
      const id = String(k._id);
      const rec = trByKey.get(id) ?? { tr: {}, status: {} };
      const keyName = String(k.keyName ?? "");
      const sourceValue = norm(rec.tr[opts.sourceLang] ?? "");
      const source = sourceValue && !(looksLikeIdentifier(sourceValue) && !looksLikeIdentifier(keyName))
        ? sourceValue
        : norm(keyName) || sourceValue;
      if (!source) continue;
      entries.push({
        id,
        project: projectName.get(String(k.projectId)) ?? String(k.projectId),
        keyName,
        source,
        description: String(k.description ?? ""),
        context: String(k.context ?? ""),
        tags: (k.tags ?? []) as string[],
        tr: rec.tr,
        status: rec.status,
      });
    }

    return {
      sourceLang: opts.sourceLang,
      langs,
      entries,
      origin: `mongodb ${opts.db} (${entries.length} keys${opts.projects?.length ? `, projects: ${opts.projects.join(", ")}` : ""})`,
    };
  } finally {
    await client.close();
  }
}
