import { createNavigationContainerRef } from '@react-navigation/native';

// Global navigation ref so non-screen code can navigate — specifically the
// TransactionAuthProvider's low-balance prompt, which needs to send the user
// to Wallet Funding from outside any screen component.
export const navigationRef = createNavigationContainerRef();
