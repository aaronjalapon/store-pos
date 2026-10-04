export interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

export abstract class ObjectStorage {
  abstract check(): Promise<void>;
  abstract put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  abstract get(key: string): Promise<StoredObject>;
  abstract copy(sourceKey: string, destinationKey: string, contentType?: string): Promise<void>;
  abstract delete(key: string): Promise<void>;
}
