export interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

export abstract class ObjectStorage {
  abstract put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  abstract get(key: string): Promise<StoredObject>;
  abstract delete(key: string): Promise<void>;
}
