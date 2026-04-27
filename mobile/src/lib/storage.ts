// Persistent storage for connection settings

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'fauna_connection';

export interface ConnectionInfo {
  host: string;
  port: number;
  token: string;
  serverName?: string;
}

export async function saveConnection(info: ConnectionInfo) {
  await AsyncStorage.setItem(KEY, JSON.stringify(info));
}

export async function loadConnection(): Promise<ConnectionInfo | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function clearConnection() {
  await AsyncStorage.removeItem(KEY);
}
