/** Small argument parser for the kit's CLIs. No dependencies, predictable shapes. */
export function parseArgs(argv) {
  const positional = [];
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    if (body.startsWith('no-')) {
      set(values, body.slice(3), false);
      continue;
    }
    const equals = body.indexOf('=');
    if (equals >= 0) {
      set(values, body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      set(values, body, next);
      index += 1;
    } else {
      set(values, body, true);
    }
  }

  return {
    positional,
    values,
    get(name, fallback = undefined) {
      return values.has(name) ? values.get(name) : fallback;
    },
    all(name) {
      const value = values.get(name);
      if (value === undefined) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    },
    flag(name) {
      return values.get(name) === true || values.get(name) === 'true';
    },
  };
}

function set(map, key, value) {
  if (map.has(key)) {
    const current = map.get(key);
    map.set(key, Array.isArray(current) ? [...current, value] : [current, value]);
  } else {
    map.set(key, value);
  }
}

/** Print a status row: [ok] / [warn] / [fail] plus a label and detail. */
export function status(kind, label, detail = '') {
  const tag = kind === 'ok' ? '[ok]  ' : kind === 'warn' ? '[warn]' : kind === 'fail' ? '[fail]' : '[info]';
  console.log(`${tag} ${label}${detail ? ' — ' + detail : ''}`);
}

/** Print aligned key/value rows. */
export function rows(entries) {
  const width = Math.max(...entries.map(([key]) => key.length), 0);
  for (const [key, value] of entries) {
    console.log(`  ${key.padEnd(width)}  ${value}`);
  }
}

export function heading(text) {
  console.log(`\n${text}`);
}
