import { create, StateCreator } from "zustand";
import { devtools, persist } from "zustand/middleware"
import { immer } from "zustand/middleware/immer"
import createSelectors from "./selector";

type AuthState = {
    accessToken: string | null;
    user: null;
    setAcccessToken: (token: string) => void;
    clearAccessToken: () => void;
};

const createAuthSlice: StateCreator<AuthState> = (set) => ({
    accessToken: null,
    user: null,
    setAcccessToken: (token) => set({ accessToken: token }),
    clearAccessToken: () => set({accessToken: null}),
}); 
type StoreType = AuthState;

export const useStoreBase = create<StoreType>()(
    devtools(
      persist( 
          immer((...a) => ({
            ...createAuthSlice(...a)
          })),
        {
          name: "session-storage", // Name of the item in localStorage (or sessionStorage)
          getStorage: () => sessionStorage, // (optional) by default it's localStorage
        }
      )
    )
  );

  export const useStore = createSelectors(useStoreBase);