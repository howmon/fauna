// Fauna Mobile — App entry point with navigation

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useColorScheme, StatusBar, Text as RNText, TouchableOpacity, ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { dark, light } from './src/lib/theme';
import * as api from './src/lib/api';
import { loadConnection } from './src/lib/storage';

import ScanScreen from './src/screens/ScanScreen';
import ChatScreen from './src/screens/ChatScreen';
import ConversationsScreen from './src/screens/ConversationsScreen';
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

// Shared ref to pass loaded conversation from ConversationsScreen to ChatScreen
const _loadedConvRef = { current: null as any };
// Ref to trigger new conversation from header button
const _newChatRef = { current: null as (() => void) | null };
const navigationRef = createNavigationContainerRef();

// Simple text-based tab icons (no font loading required)
function TabIcon({ label, color }: { label: string; color: string }) {
  return <RNText style={{ fontSize: 22, color, lineHeight: 26 }}>{label}</RNText>;
}

function MainTabs({ onDisconnect }: { onDisconnect: () => void }) {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? light : dark;

  const handleLoadConversation = useCallback((conv: any) => {
    _loadedConvRef.current = conv;
    if (navigationRef.isReady()) {
      (navigationRef as any).navigate('Chat');
    }
  }, []);

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
        options={{
          tabBarIcon: ({ color }) => <TabIcon label="✦" color={color} />,
          title: 'Chat',
          headerRight: () => (
            <TouchableOpacity onPress={() => _newChatRef.current?.()} style={{ marginRight: 14, padding: 4 }}>
              <RNText style={{ fontSize: 20, color: t.teal }}>＋</RNText>
            </TouchableOpacity>
          ),
        }}
      >
        {() => <ChatScreen loadedConvRef={_loadedConvRef} newChatRef={_newChatRef} />}
      </Tab.Screen>
      <Tab.Screen
        name="History"
        options={{ tabBarIcon: ({ color }) => <TabIcon label="☰" color={color} /> }}
      >
        {() => <ConversationsScreen onLoadConversation={handleLoadConversation} />}
      </Tab.Screen>
      <Tab.Screen
        name="Tasks"
        component={TasksStack}
        options={{ headerShown: false, tabBarIcon: ({ color }) => <TabIcon label="▢" color={color} /> }}
      />
      <Tab.Screen
        name="Settings"
        options={{ tabBarIcon: ({ color }) => <TabIcon label="⋮" color={color} /> }}
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
        if (conn.tunnelUrl) {
          api.configureUrl(conn.tunnelUrl, conn.token);
        } else {
          api.configure(conn.host, conn.port, conn.token);
        }
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
    // Loading splash — show spinner so the screen is never blank
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={t.teal} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={scheme === 'light' ? 'dark-content' : 'light-content'} backgroundColor={t.bg} />
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        {connected ? (
          <MainTabs onDisconnect={handleDisconnect} />
        ) : (
          <ScanScreen onConnected={handleConnected} />
        )}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
