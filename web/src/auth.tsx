import { createContext, useContext } from 'react'
import type { UserProfile } from './api'

interface AuthValue {
  me: UserProfile | null
}

export const AuthContext = createContext<AuthValue>({ me: null })
export const useMe = () => useContext(AuthContext).me
