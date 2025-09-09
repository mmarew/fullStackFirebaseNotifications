import { View, Text, PermissionsAndroid } from 'react-native';
import React, { useEffect } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import messaging from '@react-native-firebase/messaging';

export default function App() {
  const requestUserPermission = async () => {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      {
        title: 'Permission Required',
        message: 'This app needs notification permissions to function properly',
        buttonPositive: 'Allow',
        buttonNegative: 'Cancel',
      },
    );
    if (granted === PermissionsAndroid.RESULTS.GRANTED) {
      console.log('Notification permission granted');
    } else {
      console.log('Notification permission denied');
    }
  };
  // get token from Messaging()
  const getToken = async () => {
    try {
      const token = await messaging().getToken();
      if (token) {
        console.log('FCM Token:', token);
      } else {
        console.log('FCM Token not found');
      }
    } catch (error) {
      console.log('Error getting FCM token:', error);
    }
  };

  useEffect(() => {
    requestUserPermission();
    getToken();
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <View>
        <Text>App</Text>
      </View>
    </SafeAreaView>
  );
}
