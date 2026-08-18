import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppTheme } from '../constants/theme';
import { useTheme } from '../components/ThemeProvider';
import { deviceSessionService, DeviceSession } from '../services/deviceSession.service';

export default function ActiveSessionsScreen({ navigation }: { navigation: any }) {
  const { theme } = useTheme(); const s = createStyles(theme);
  const [items,setItems]=useState<DeviceSession[]>([]); const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{try{setItems(await deviceSessionService.list());}catch{Alert.alert('Error','Could not load active devices.');}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  const revoke=(item:DeviceSession)=>Alert.alert('Remove device',`Remove ${item.device_name}?`,[{text:'Cancel',style:'cancel'},{text:'Remove',style:'destructive',onPress:async()=>{await deviceSessionService.revoke(item.id); await load();}}]);
  const revokeOthers=()=>Alert.alert('Log out other devices','This will block financial and identity actions on every other registered device.',[{text:'Cancel',style:'cancel'},{text:'Log out others',style:'destructive',onPress:async()=>{await deviceSessionService.revokeOthers();await load();}}]);
  return <SafeAreaView style={s.root}><View style={s.header}><TouchableOpacity style={s.touch} onPress={()=>navigation.goBack()}><Ionicons name="arrow-back" size={24} color={theme.ink}/></TouchableOpacity><Text style={s.title}>Active Sessions</Text><View style={s.touch}/></View>
    {loading?<ActivityIndicator style={{marginTop:40}} color={theme.brand}/>:<FlatList data={items} keyExtractor={x=>x.id} contentContainerStyle={s.list} ListHeaderComponent={<Text style={s.note}>Devices signed in to your account. Your current device cannot be removed here.</Text>} renderItem={({item})=><View style={s.card}><Ionicons name={item.platform==='android'?'logo-android':item.platform==='ios'?'logo-apple':'phone-portrait-outline'} size={28} color={theme.brand}/><View style={s.info}><Text style={s.name}>{item.device_name}{item.is_current?' (This device)':''}</Text><Text style={s.date}>Last active {new Date(item.last_active_at).toLocaleString()}</Text></View>{!item.is_current&&!item.revoked_at&&<TouchableOpacity style={s.remove} onPress={()=>revoke(item)}><Text style={s.removeText}>Remove</Text></TouchableOpacity>}</View>} ListFooterComponent={<TouchableOpacity style={s.all} onPress={revokeOthers}><Text style={s.allText}>Log out all other devices</Text></TouchableOpacity>}/>}
  </SafeAreaView>;
}
function createStyles(theme: AppTheme) {
  return StyleSheet.create({root:{flex:1,backgroundColor:theme.background},header:{height:64,flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderBottomColor:theme.border},touch:{width:56,height:56,alignItems:'center',justifyContent:'center'},title:{flex:1,textAlign:'center',fontSize:20,fontWeight:'700',color:theme.ink},list:{padding:20},note:{color:theme.inkMuted,lineHeight:20,marginBottom:18},card:{minHeight:76,flexDirection:'row',alignItems:'center',padding:14,borderRadius:12,backgroundColor:theme.surfaceRaised,marginBottom:12},info:{flex:1,marginLeft:12},name:{fontSize:15,fontWeight:'700',color:theme.ink},date:{fontSize:12,color:theme.inkMuted,marginTop:4},remove:{minWidth:64,minHeight:44,alignItems:'center',justifyContent:'center'},removeText:{color:theme.down,fontWeight:'700'},all:{minHeight:50,marginTop:16,borderRadius:12,borderWidth:1,borderColor:theme.down,alignItems:'center',justifyContent:'center'},allText:{color:theme.down,fontWeight:'700'}});
}
