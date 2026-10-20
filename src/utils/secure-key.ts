import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const SECURE_API_KEY_NAME = 'NEXUS_API_KEY';

export async function getApiKey(): Promise<string | null> {
  const secureValue = await SecureStore.getItemAsync(SECURE_API_KEY_NAME);
  if (secureValue) return secureValue;

  const legacyValue = await AsyncStorage.getItem(SECURE_API_KEY_NAME);
  if (legacyValue) {
    await SecureStore.setItemAsync(SECURE_API_KEY_NAME, legacyValue);
    await AsyncStorage.removeItem(SECURE_API_KEY_NAME);
    return legacyValue;
  }

  return null;
}

export async function setApiKey(value: string): Promise<void> {
  await SecureStore.setItemAsync(SECURE_API_KEY_NAME, value);
  await AsyncStorage.removeItem(SECURE_API_KEY_NAME);
}

export async function deleteApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(SECURE_API_KEY_NAME);
  await AsyncStorage.removeItem(SECURE_API_KEY_NAME);
}
