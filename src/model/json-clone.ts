export function cloneJsonValue<T>(value: T): T {
  return cloneValue(
    value,
    new WeakMap<object, unknown>(),
    new WeakSet<object>(),
  ) as T;
}

function cloneValue(
  value: unknown,
  clones: WeakMap<object, unknown>,
  active: WeakSet<object>,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON clone requires a finite number.");
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new TypeError(`JSON clone does not support ${typeof value} values.`);
  }
  if (active.has(value)) {
    throw new TypeError("JSON clone does not support cyclic values.");
  }
  const existing = clones.get(value);
  if (existing !== undefined) return existing;

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const result = new Array<unknown>(value.length);
      clones.set(value, result);
      for (let index = 0; index < value.length; index += 1) {
        if (Object.hasOwn(value, index)) {
          result[index] = cloneValue(value[index], clones, active);
        }
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON clone requires arrays or plain objects.");
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new TypeError("JSON clone does not support symbol properties.");
    }

    const result = Object.create(prototype) as Record<string, unknown>;
    clones.set(value, result);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("JSON clone does not support accessor properties.");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneValue(descriptor.value, clones, active),
        writable: true,
      });
    }
    return result;
  } finally {
    active.delete(value);
  }
}
