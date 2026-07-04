# Kay's Pay - Agent Rules

## CRITICAL RULES (MUST FOLLOW)

### 1. No Changes Without Approval
- **NEVER** make any code changes, file modifications, or architectural decisions without explicit approval from the user
- Before suggesting ANY change, explain:
  - What the change is
  - Why it's needed
  - What problem it solves
  - What risks it carries
- Wait for explicit approval before implementing

### 2. Security First - Never Expose Secrets
- **NEVER** commit API keys, secrets, or credentials to any file
- **NEVER** hardcode sensitive data in source code
- **NEVER** expose environment variables in client-side code
- All secrets MUST be stored in:
  - `.env` file (gitignored) - for Expo public keys only
  - Supabase Edge Function secrets - for server-side keys
  - Environment variables on the server
- Before committing, always verify no secrets are present in the code

### 3. Senior Developer Standards
- Write production-ready, enterprise-grade code
- Follow React Native and TypeScript best practices
- Implement proper error handling for ALL operations
- Write clean, maintainable, and well-structured code
- Use proper naming conventions and code organization
- Implement proper logging for debugging (but never log sensitive data)

### 4. Target Audience Considerations
- **Primary Users:** Nigerian users (30,000+ concurrent)
- **Network Considerations:** Optimize for varying network conditions
  - Implement offline queue for transactions
  - Handle slow connections gracefully
  - Use proper loading states and feedback
- **Device Considerations:** Support older Android devices
  - Min SDK 24 (Android 7.0)
  - Optimize for smaller screens
  - Ensure touch targets are minimum 44×44px
- **UX Considerations:**
  - Clear, simple UI with large touch targets
  - Nigerian phone number format support (0803xxxxxxx)
  - Local currency (NGN) formatting
  - Network auto-detection (MTN, Airtel, Glo, 9mobile)

### 5. Code Quality Standards
- **TypeScript:** Use strict typing, avoid `any`
- **Error Handling:** Every async operation must have error handling
- **Loading States:** Every screen needs loading, error, and empty states
- **Validation:** Validate all user inputs before processing
- **Security:** Never trust client-side data for financial operations
- **Performance:** Use FlatList, memoization, and proper caching
- **Testing:** Write testable code, consider edge cases

### 6. Financial Transaction Rules
- **Atomic Operations:** All wallet debits must be atomic (server-side only)
- **Idempotency:** All VTU calls must use idempotency keys
- **Rollback:** Implement proper rollback on failures
- **Audit Trail:** Every transaction must be logged
- **Balance Checks:** Always verify balance server-side before debiting
- **Double-Submit Prevention:** Handle double-tap scenarios

## PROJECT STRUCTURE
```
KaysPay/
  src/
    screens/          # All screen components
    components/       # Reusable UI components
    navigation/       # Navigation configuration
    lib/              # Supabase, MMKV, SQLite setup
    utils/            # Utility functions (detectNetwork, etc.)
    hooks/            # Custom React hooks
    services/         # API service functions
    types/            # TypeScript type definitions
    constants/        # Colors, spacing, strings
    assets/           # Images, fonts, icons
  supabase/
    migrations/       # SQL migration files
    functions/        # Edge Functions
```

## SDK VERSION
- **Expo SDK 54** (expo@~54.0.0)
- **React Native 0.81.5** (bridgeless architecture)
- **React 19.1.0**
- Read versioned docs at https://docs.expo.dev/versions/v54.0.0/

## DEVELOPMENT WORKFLOW
1. Plan phase: Explain what you want to do and why
2. Wait for approval
3. Implement with best practices
4. Verify no secrets are exposed
5. Test for error handling
6. Document any complex logic

## REMEMBER
- This is a FINANCIAL application - security is paramount
- Nigerian users depend on this for daily transactions
- 30,000+ concurrent users means performance matters
- Every decision should consider: "What if this fails?"
- When in doubt, ask for clarification before proceeding
