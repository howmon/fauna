// Fauna Mobile — App entry point with navigation

import React, { useState, useEffect, useCallback } from 'react';
import { useColorScheme, StatusBar } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { dark, light } from './src/lib/theme';
import * as api from './src/lib/api';
import { loadConnection } from './src/lib/storage';

import ScanScreen from './src/screens/ScanScreen';
import ChatScreen from './src/screens/ChatScreen';
import TasksScreen from './src/screens/TasksScreen';
import TaskDetailScreen from './src/screens/TaskDetailScreen';
import TaskCreateScreen from './src/screens/TaskCreateScreen';
import SettingsScreen from './src/screens/SettingsScreen';

type TasksStackParams = {
  TasksList: undefined;
  TaskDetail: { taskId: string };
  TaskCreate: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<TasksStackParams>();

// ── Task stack (list → detail / create) ──────────────────────────────────

function TasksStack() {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Screen name="TasksList" component={TasksScreen} options={{ title: 'Tasks' }} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task' }} />
      <Stack.Screen name="TaskCreate" component={TaskCreateScreen} options={{ title: 'New Task' }} />
    </Stack.Navigator>
  );
}

// ── Main tabs ─────────────────────────────────────────────────────────────

function MainTabs({ onDisconnect }: { onDisconnect: () => void }) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;

  return (
    <Tab.Navigator
      screenOptions={{
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        tabBarActiveTintColor: t.teal,
        tabBarInactiveTintColor: t.textMuted,
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="chatbubble-outline" size={size} color={color} />, title: 'Chat' }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksStack}
        options={{ headerShown: false, tabBarIcon: ({ color, size }) => <Ionicons name="list-outline" size={size} color={color} /> }}
      />
      <Tab.Screen
        name="Settings"
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} /> }}
      >
        {() => <SettingsScreen onDisconnect={onDisconnect} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

// ── Root app ──────────────────────────────────────────────────────────────

export default function App() {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;
  const [connected, setConnected] = useState<boolean | null>(null); // null = loading

  const navTheme = scheme === 'light' ? {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: t.bg, card: t.surface, text: t.text, border: t.border, primary: t.teal },
  } : {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, background: t.bg, card: t.surface, text: t.text, border: t.border, primary: t.teal },
  };

  useEffect(() => {
    (async () => {
      const conn = await loadConnection();
      if (conn) {
        api.configure(conn.host, conn.port, conn.token);
        const ok = await api.verifyConnection();
        setConnected(ok);
      } else {
        setConnected(false);
      }
    })();
  }, []);

  const handleConnected = useCallback(() => setConnected(true), []);
  const handleDisconnect = useCallback(() => setConnected(false), []);

  if (connected === null) {
    // Loading splash
    return null;
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} backgroundColor={t.bg} />
      <NavigationContainer theme={navTheme}>
        {connected ? (
          <MainTabs onDisconnect={handleDisconnect} />
        ) : (
          <ScanScreen onConnected={handleConnected} />
        )}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
