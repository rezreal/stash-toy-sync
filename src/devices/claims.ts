// Which instance holds which physical device. With several instances of one
// kind (two Coyotes), two of them must never drive the same device: an
// instance claims a device's key when it picks it (connect, reconnect or
// resume) and releases it on disconnect, removal and dispose. One registry
// per page, shared by every driver through its DriverContext. Pure.
//
// Keys are the physical device ids: the Bluetooth device id for Lovense,
// Coyote and PiuPiu; for Web Serial (TCode), which has no stable per-port id,
// a page-local key per SerialPort object (src/tcode/engine.ts: portClaimKey).
// Keys of different kinds can't collide (Bluetooth ids are per device, the
// serial keys have their own prefix).
//
// A claim is only ever refused, never stolen: a driver that finds its device
// held by another instance leaves it alone (a picked one is refused with
// alreadyConnectedMessage(), a remembered one is skipped quietly).

export interface ClaimRegistry {
  /** the key is held by some instance; with byInstance: by that instance */
  isClaimed(key: string, byInstance?: string): boolean;
  /** takes the key for instanceId; false when another instance holds it (true when it already holds it) */
  claim(key: string, instanceId: string): boolean;
  /** gives the key back; only its holder can */
  release(key: string, instanceId: string): void;
  /** the instance holding the key, undefined when free */
  holder(key: string): string | undefined;
  /** the holder's current name (for messages), undefined when free */
  holderName(key: string): string | undefined;
  /** releases every key an instance holds (the instance was removed) */
  releaseAll(instanceId: string): void;
  /**
   * Runs fn once no other exclusive() is running, in call order. Bluetooth
   * stacks handle one GATT connect (and service discovery) at a time far
   * better than several at once - a second one can hang or fail with "GATT
   * operation already in progress" - so drivers open their links through
   * this. fn must be time-limited (a hung one would hold everybody up);
   * onWait is called right away when fn has to queue behind another.
   */
  exclusive<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T>;
}

export function createClaimRegistry(nameOf: (instanceId: string) => string | undefined = () => undefined): ClaimRegistry {
  const held = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let busy = false;
  return {
    exclusive(fn, onWait) {
      if (busy || queued > 0) onWait?.();
      queued++;
      const run = tail.then(async () => {
        queued--;
        busy = true;
        try {
          return await fn();
        } finally {
          busy = false;
        }
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    isClaimed(key, byInstance) {
      const h = held.get(key);
      if (h === undefined) return false;
      return byInstance === undefined || h === byInstance;
    },
    claim(key, instanceId) {
      if (!key) return true;
      const h = held.get(key);
      if (h !== undefined && h !== instanceId) return false;
      held.set(key, instanceId);
      return true;
    },
    release(key, instanceId) {
      if (held.get(key) === instanceId) held.delete(key);
    },
    holder: (key) => held.get(key),
    holderName(key) {
      const h = held.get(key);
      return h === undefined ? undefined : (nameOf(h) ?? h);
    },
    releaseAll(instanceId) {
      for (const [k, h] of [...held]) if (h === instanceId) held.delete(k);
    },
  };
}

/** the status message when the picker returns a device another instance already drives */
export function alreadyConnectedMessage(name: string): string {
  return `Already connected as "${name}". Pick a different device, or disconnect it there first.`;
}

/** one instance's view of the registry, as the drivers use it */
export interface InstanceClaims {
  /** the name of the other instance holding the key; undefined when it is free or ours */
  heldByOther(key: string): string | undefined;
  /** false when another instance holds it */
  claim(key: string): boolean;
  release(key: string): void;
  /** the registry's exclusive(); without a registry fn just runs */
  exclusive<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T>;
}

/** no registry (tests, old callers): every key is free and nothing queues */
export const NO_CLAIMS: InstanceClaims = {
  heldByOther: () => undefined,
  claim: () => true,
  release: () => undefined,
  exclusive: (fn) => fn(),
};

/** binds the registry to one instance; without a registry (tests, old callers) every key is free */
export function instanceClaims(registry: ClaimRegistry | undefined, instanceId: string): InstanceClaims {
  if (!registry) return NO_CLAIMS;
  return {
    heldByOther(key) {
      if (!key || !registry.isClaimed(key) || registry.isClaimed(key, instanceId)) return undefined;
      return registry.holderName(key) ?? "another device";
    },
    claim: (key) => registry.claim(key, instanceId),
    release: (key) => registry.release(key, instanceId),
    exclusive: (fn, onWait) => registry.exclusive(fn, onWait),
  };
}
