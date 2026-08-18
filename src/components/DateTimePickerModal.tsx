import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppTheme } from '../constants/theme';
import { useTheme } from './ThemeProvider';
import { Spacing } from '../constants/spacing';
import { Typography } from '../constants/typography';

interface Props {
  visible: boolean;
  onClose: () => void;
  onConfirm: (date: Date) => void;
  initial?: Date | null;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');

// Nigeria is Africa/Lagos = UTC+1, no DST. Building the ISO string with an
// explicit +01:00 offset means the date/time the user picks is always
// interpreted as Nigerian time (WAT), regardless of the device's timezone.
function toWatDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(`${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+01:00`);
}

export default function DateTimePickerModal({ visible, onClose, onConfirm, initial }: Props) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const base = initial ?? new Date();
  const [viewYear, setViewYear] = useState(base.getFullYear());
  const [viewMonth, setViewMonth] = useState(base.getMonth());
  const [selDay, setSelDay] = useState<number | null>(initial ? base.getDate() : null);
  const [hour, setHour] = useState(initial ? base.getHours() : 9);
  const [minute, setMinute] = useState(initial ? base.getMinutes() : 0);

  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();

  const cells = useMemo(() => {
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const arr: (number | null)[] = [];
    for (let i = 0; i < firstDow; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    return arr;
  }, [viewYear, viewMonth]);

  const isPast = (day: number) => {
    if (viewYear < todayY) return true;
    if (viewYear === todayY && viewMonth < todayM) return true;
    if (viewYear === todayY && viewMonth === todayM && day < todayD) return true;
    return false;
  };

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  const canConfirm = selDay !== null;

  const handleConfirm = () => {
    if (selDay === null) return;
    onConfirm(toWatDate(viewYear, viewMonth, selDay, hour, minute));
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.sheet} edges={['bottom']}>
          <View style={styles.header}>
            <Text style={styles.title}>Select date & time</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.close}>✕</Text></TouchableOpacity>
          </View>

          <View style={styles.monthRow}>
            <TouchableOpacity onPress={prevMonth} style={styles.navBtn}><Text style={styles.navText}>{'‹'}</Text></TouchableOpacity>
            <Text style={styles.monthLabel}>{MONTHS[viewMonth]} {viewYear}</Text>
            <TouchableOpacity onPress={nextMonth} style={styles.navBtn}><Text style={styles.navText}>{'›'}</Text></TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {WEEKDAYS.map((w) => <Text key={w} style={styles.weekday}>{w}</Text>)}
          </View>

          <View style={styles.grid}>
            {cells.map((d, i) => {
              if (d === null) return <View key={`b${i}`} style={styles.cell} />;
              const disabled = isPast(d);
              const selected = selDay === d;
              return (
                <TouchableOpacity
                  key={d}
                  style={[styles.cell, selected && styles.cellSelected]}
                  disabled={disabled}
                  onPress={() => setSelDay(d)}
                >
                  <Text style={[styles.cellText, disabled && styles.cellDisabled, selected && styles.cellTextSelected]}>{d}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.timeLabel}>Time (Nigerian time · WAT)</Text>
          <View style={styles.timeRow}>
            <View style={styles.timeCol}>
              <Text style={styles.timeColLabel}>Hour</Text>
              <ScrollView style={styles.timeScroll} showsVerticalScrollIndicator={false}>
                {Array.from({ length: 24 }, (_, h) => (
                  <TouchableOpacity key={h} style={[styles.timeItem, hour === h && styles.timeItemActive]} onPress={() => setHour(h)}>
                    <Text style={[styles.timeItemText, hour === h && styles.timeItemTextActive]}>{pad(h)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <View style={styles.timeCol}>
              <Text style={styles.timeColLabel}>Minute</Text>
              <ScrollView style={styles.timeScroll} showsVerticalScrollIndicator={false}>
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                  <TouchableOpacity key={m} style={[styles.timeItem, minute === m && styles.timeItemActive]} onPress={() => setMinute(m)}>
                    <Text style={[styles.timeItemText, minute === m && styles.timeItemTextActive]}>{pad(m)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <View style={styles.selectedTimeBox}>
              <Text style={styles.selectedTimeLabel}>Selected</Text>
              <Text style={styles.selectedTime}>{pad(hour)}:{pad(minute)}</Text>
              {selDay !== null && (
                <Text style={styles.selectedDate}>{MONTHS[viewMonth].slice(0, 3)} {selDay}</Text>
              )}
            </View>
          </View>

          <TouchableOpacity
            style={[styles.confirmBtn, !canConfirm && styles.confirmBtnDisabled]}
            onPress={handleConfirm}
            disabled={!canConfirm}
          >
            <Text style={styles.confirmText}>Confirm</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: Spacing.L, paddingTop: Spacing.L },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.L },
  title: { ...Typography.SECTION_HEADING, color: theme.ink },
  close: { fontSize: 20, color: theme.ink, paddingHorizontal: Spacing.S },
  monthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.M },
  navBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  navText: { fontSize: 26, color: theme.brand, fontWeight: '700' },
  monthLabel: { ...Typography.BODY, fontWeight: '700', color: theme.ink },
  weekRow: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', ...Typography.CAPTION, color: theme.inkMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: Spacing.S, marginBottom: Spacing.M },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, justifyContent: 'center', alignItems: 'center' },
  cellSelected: { },
  cellText: { ...Typography.BODY, color: theme.ink },
  cellDisabled: { color: theme.hairline },
  cellTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
    overflow: 'hidden',
    backgroundColor: theme.brand,
    width: 36,
    height: 36,
    borderRadius: 18,
    textAlign: 'center',
    textAlignVertical: 'center',
    lineHeight: 36,
  },
  timeLabel: { ...Typography.CAPTION, color: theme.inkMuted, marginBottom: Spacing.S },
  timeRow: { flexDirection: 'row', gap: Spacing.M, height: 130, marginBottom: Spacing.L },
  timeCol: { flex: 1 },
  timeColLabel: { ...Typography.CAPTION, color: theme.inkMuted, textAlign: 'center', marginBottom: Spacing.XS },
  timeScroll: { flex: 1, borderWidth: 1, borderColor: theme.border, borderRadius: Spacing.BUTTON_RADIUS },
  timeItem: { paddingVertical: Spacing.S, alignItems: 'center' },
  timeItemActive: { backgroundColor: theme.brandSoft },
  timeItemText: { ...Typography.BODY, color: theme.ink },
  timeItemTextActive: { color: theme.brand, fontWeight: '700' },
  selectedTimeBox: { flex: 1, borderWidth: 1, borderColor: theme.brand, borderRadius: Spacing.BUTTON_RADIUS, justifyContent: 'center', alignItems: 'center' },
  selectedTimeLabel: { ...Typography.CAPTION, color: theme.inkMuted },
  selectedTime: { ...Typography.HEADING, color: theme.brand, fontWeight: '700' },
  selectedDate: { ...Typography.CAPTION, color: theme.ink, marginTop: 2 },
  confirmBtn: { height: Spacing.BUTTON_HEIGHT_PRIMARY, backgroundColor: theme.brand, borderRadius: Spacing.BUTTON_RADIUS, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.S },
  confirmBtnDisabled: { opacity: 0.5 },
  confirmText: { ...Typography.BUTTON_TEXT, color: '#FFFFFF' },
  });
}
