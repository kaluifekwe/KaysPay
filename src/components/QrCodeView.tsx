import React, { useMemo } from 'react';
import { View } from 'react-native';
import qrcode from 'qrcode-generator';

interface QrCodeViewProps {
  value: string;
  size?: number;
  color?: string;
  backgroundColor?: string;
}

// Plain View-grid QR renderer — no react-native-svg dependency in this
// project, so this renders qrcode-generator's module matrix as a grid of
// small Views instead (the same library NinServicesScreen already uses for
// the printable slip's QR, just rendered live instead of as an SVG string).
export default function QrCodeView({ value, size = 180, color = '#000', backgroundColor = '#fff' }: QrCodeViewProps) {
  const modules = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value || '');
    qr.make();
    const count = qr.getModuleCount();
    const rows: boolean[][] = [];
    for (let row = 0; row < count; row++) {
      const cols: boolean[] = [];
      for (let col = 0; col < count; col++) cols.push(qr.isDark(row, col));
      rows.push(cols);
    }
    return rows;
  }, [value]);

  const cellSize = size / modules.length;

  return (
    <View style={{ width: size, height: size, backgroundColor }}>
      {modules.map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: 'row' }}>
          {row.map((dark, colIndex) => (
            <View
              key={colIndex}
              style={{
                width: cellSize,
                height: cellSize,
                backgroundColor: dark ? color : backgroundColor,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
