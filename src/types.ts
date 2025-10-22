export type AlkanesType = string;

export interface AlkanesInput {
  name: string;
  type: AlkanesType;
}

export interface AlkanesMethod {
  opcode: number;
  name: string;
  doc?: string;
  inputs: AlkanesInput[];
  outputs: string[];
}

export interface StorageKey {
  key: string;
  type: AlkanesType;
}

export interface AlkanesABI {
  name: string;
  version: string;
  methods: AlkanesMethod[];
  storage: StorageKey[];
  opcodes: Record<string, number>;
}
