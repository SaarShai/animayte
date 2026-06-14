import re

def detect_renames(prev_snapshot, curr_snapshot, prev_bodies, curr_bodies):
    def _extract_identifiers(source_bytes):
        # 'replace', not strict: a single non-UTF-8 byte (valid in a string
        # literal/comment) raised UnicodeDecodeError, which render_diff's broad
        # except swallowed — silently disabling rename detection for the whole
        # file. Match the "replace" policy used everywhere else in core.py.
        source = source_bytes.decode('utf-8', 'replace')
        return set(re.findall(r'\b[a-zA-Z_][a-zA-Z0-9_]*\b', source))
    
    removed_names = set(prev_snapshot.keys()) - set(curr_snapshot.keys())
    added_names = set(curr_snapshot.keys()) - set(prev_snapshot.keys())
    
    old_id_map = {}
    for old_name in removed_names:
        source_bytes = prev_bodies.get(old_name, b'')
        ids = _extract_identifiers(source_bytes)
        if old_name in ids:
            ids.remove(old_name)
        old_id_map[old_name] = ids
    
    new_id_map = {}
    for new_name in added_names:
        source_bytes = curr_bodies.get(new_name, b'')
        ids = _extract_identifiers(source_bytes)
        if new_name in ids:
            ids.remove(new_name)
        new_id_map[new_name] = ids
    
    candidates = []
    for old_name in removed_names:
        old_ids = old_id_map[old_name]
        for new_name in added_names:
            new_ids = new_id_map[new_name]
            common = len(old_ids & new_ids)
            total = len(old_ids | new_ids)
            if total == 0:
                similarity = 0.0
            else:
                similarity = common / total
            if similarity > 0.7:
                candidates.append((old_name, new_name, similarity))

    # Greedy 1:1 assignment: take candidates best-first, claiming each old and
    # each new name at most once. A genuinely-new function that merely shares a
    # boilerplate identifier set with some removed function is left unclaimed,
    # so core.render_diff keeps it in `added` and renders its body.
    candidates.sort(key=lambda x: -x[2])
    results = []
    claimed_old = set()
    claimed_new = set()
    for old_name, new_name, similarity in candidates:
        if old_name in claimed_old or new_name in claimed_new:
            continue
        claimed_old.add(old_name)
        claimed_new.add(new_name)
        results.append((old_name, new_name, similarity))
    return results
