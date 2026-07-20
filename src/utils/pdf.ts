import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import { storageHelpers, StorageKeys } from '../lib/mmkv';

// Shared by every PDF generated in the app (NIN/BVN slips, electricity
// receipts, etc.) — one file produced by expo-print, then either handed to
// the OS share sheet or saved directly. Extracted here so every screen that
// generates a PDF reuses the same tested download/share behavior instead of
// each maintaining its own copy.
export async function sharePdf(html: string, dialogTitle: string): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html });
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle });
}

// "Download" has no single OS-level meaning across platforms: Android's
// scoped storage requires the user to pick a destination folder via the
// Storage Access Framework (there's no way to silently write into Downloads
// without that one-time picker); iOS has no public Downloads folder at all,
// so the closest equivalent is the share sheet's built-in "Save to Files"
// destination.
//
// The SAF folder grant is persistable, so we only ever ask once: the chosen
// directoryUri is cached, and every later download writes straight into it
// with no picker at all. If that saved permission ever stops working (folder
// deleted, permission revoked outside the app, etc.) we silently fall back
// to asking again.
export async function downloadPdf(html: string, filenameBase: string): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html });
  if (Platform.OS === 'android') {
    const base64 = await new File(uri).base64();
    const writeInto = async (dirUri: string) => {
      const destUri = await StorageAccessFramework.createFileAsync(dirUri, filenameBase, 'application/pdf');
      await StorageAccessFramework.writeAsStringAsync(destUri, base64, { encoding: 'base64' });
    };

    const savedFolderUri = await storageHelpers.getString(StorageKeys.DOWNLOAD_FOLDER_URI);
    if (savedFolderUri) {
      try {
        await writeInto(savedFolderUri);
        return;
      } catch {
        // Saved grant no longer works — fall through and ask again below.
      }
    }

    const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms.granted) throw new Error('Choose a folder to save the PDF into.');
    await storageHelpers.setString(StorageKeys.DOWNLOAD_FOLDER_URI, perms.directoryUri);
    await writeInto(perms.directoryUri);
  } else {
    if (!(await Sharing.isAvailableAsync())) throw new Error("Saving files isn't available on this device.");
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Save ${filenameBase}`, UTI: 'com.adobe.pdf' });
  }
}
