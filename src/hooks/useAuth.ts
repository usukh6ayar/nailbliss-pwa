import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { User, AuthState } from '../types';

const REMEMBER_ME_KEY = 'nailbliss_remember_me';

export const useAuth = (): AuthState & {
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  isResettingPassword: boolean;
  resetPasswordError: string | null;
  connectionStatus: 'connected' | 'disconnected' | 'checking';
  lastError: Error | null;
} => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');
  const [lastError, setLastError] = useState<Error | null>(null);

  // Test Supabase connection
  const testConnection = useCallback(async () => {
    try {
      setConnectionStatus('checking');
      
      // Simple health check - try to get session
      const { error } = await supabase.auth.getSession();
      
      if (error) {
        // If it's a network error, mark as disconnected
        if (error.message?.includes('fetch') || error.message?.includes('network')) {
          setConnectionStatus('disconnected');
          return false;
        }
      }
      
      setConnectionStatus('connected');
      return true;
    } catch (error) {
      setConnectionStatus('disconnected');
      return false;
    }
  }, []);

  const handleError = useCallback((error: any, operation: string): Error => {
    console.error(`Auth Error [${operation}]:`, error);
    
    let userMessage = '';
    
    // Handle specific error types
    if (error?.message?.includes('fetch') || error?.message?.includes('network')) {
      userMessage = "Network connection failed. Please check your internet connection and try again.";
      setConnectionStatus('disconnected');
    } else if (error?.message?.includes('Invalid login credentials') || error?.code === 'invalid_credentials') {
      userMessage = "Invalid email or password. Please check your credentials and try again.";
    } else if (error?.message?.includes('Email not confirmed') || error?.code === 'email_not_confirmed') {
      userMessage = "Please check your email and click the confirmation link before signing in.";
    } else if (error?.message?.includes('User already registered') || error?.code === 'user_already_exists') {
      userMessage = "An account with this email already exists. Please sign in instead.";
    } else if (error?.message?.includes('row-level security policy') || error?.code === '42501') {
      userMessage = "Account permissions issue. Please contact support if this persists.";
    } else if ([500, 502, 503, 504].includes(error?.status)) {
      userMessage = "Our servers are temporarily unavailable. Please try again in a few minutes.";
      setConnectionStatus('disconnected');
    } else {
      userMessage = error?.message || "An unexpected error occurred. Please try again.";
    }
    
    const enhancedError = new Error(userMessage);
    setLastError(enhancedError);
    return enhancedError;
  }, []);

  const fetchUserProfile = useCallback(async (userId: string): Promise<User> => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        throw handleError(error, 'fetching user profile');
      }

      if (!data) {
        throw handleError(new Error('User profile data is empty'), 'fetching user profile');
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw handleError(error, 'fetching user profile');
    }
  }, [handleError]);

  useEffect(() => {
    let mounted = true;

    const initializeAuth = async () => {
      try {
        // Test connection first
        const isConnected = await testConnection();
        if (!isConnected) {
          if (mounted) {
            setLoading(false);
          }
          return;
        }

        const rememberMe = localStorage.getItem(REMEMBER_ME_KEY) === 'true';
        
        if (!rememberMe) {
          await supabase.auth.signOut();
          if (mounted) {
            setUser(null);
            setLoading(false);
          }
          return;
        }

        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
          handleError(error, 'getting session');
          localStorage.removeItem(REMEMBER_ME_KEY);
          if (mounted) {
            setLoading(false);
          }
          return;
        }

        if (session?.user) {
          try {
            const userData = await fetchUserProfile(session.user.id);
            if (mounted) {
              setUser(userData);
            }
          } catch (error) {
            console.error('Error fetching user profile:', error);
            if (mounted) {
              setUser(null);
            }
          }
        } else {
          localStorage.removeItem(REMEMBER_ME_KEY);
          if (mounted) {
            setUser(null);
          }
        }
      } catch (error) {
        handleError(error, 'initializing auth');
        localStorage.removeItem(REMEMBER_ME_KEY);
        if (mounted) {
          setUser(null);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    initializeAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      try {
        if (event === 'SIGNED_OUT') {
          setUser(null);
          setLoading(false);
          return;
        }

        if (event === 'PASSWORD_RECOVERY') {
          setLoading(false);
          return;
        }

        if (session?.user) {
          setLoading(true);
          try {
            // Add a small delay to ensure the user profile is created
            if (event === 'SIGNED_UP') {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            const userData = await fetchUserProfile(session.user.id);
            setUser(userData);
          } catch (error) {
            // If profile not found and this is a new signup, wait and retry
            if (error.message?.includes('User profile not found') || error.message?.includes('0 rows')) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              try {
                const userData = await fetchUserProfile(session.user.id);
                setUser(userData);
              } catch (retryError) {
                console.error('Profile still not found after retry:', retryError);
                setUser(null);
              }
            } else {
              setUser(null);
            }
          }
          setLoading(false);
        } else {
          setUser(null);
          setLoading(false);
        }
      } catch (error) {
        handleError(error, 'auth state change');
        setUser(null);
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [fetchUserProfile, handleError, testConnection]);

  const signUp = async (
    email: string, 
    password: string, 
    fullName: string, 
    role: 'customer' | 'staff' = 'customer', 
    rememberMe: boolean = false
  ) => {
    try {
      setLoading(true);
      setLastError(null);

      // Test connection before attempting signup
      const isConnected = await testConnection();
      if (!isConnected) {
        throw handleError(new Error('Unable to connect to authentication service'), 'testing connection');
      }

      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { role }
        }
      });

      if (error) {
        throw handleError(error, 'signing up');
      }

      if (!data.user) {
        throw handleError(new Error('User creation failed - no user data returned'), 'signing up');
      }

      // Wait a bit before creating profile to ensure auth user is fully created
      await new Promise(resolve => setTimeout(resolve, 500));

      const { error: profileError } = await supabase
        .from('users')
        .insert({
          id: data.user.id,
          email: email.trim(),
          full_name: fullName.trim(),
          role,
          current_points: 0,
          total_visits: 0,
        });

      if (profileError) {
        throw handleError(profileError, 'creating user profile');
      }

      if (rememberMe) {
        localStorage.setItem(REMEMBER_ME_KEY, 'true');
      } else {
        localStorage.removeItem(REMEMBER_ME_KEY);
      }

      setLoading(false);
    } catch (error) {
      setLoading(false);
      if (error instanceof Error) {
        throw error;
      }
      throw handleError(error, 'signing up');
    }
  };

  const signIn = async (email: string, password: string, rememberMe: boolean = false) => {
    try {
      setLoading(true);
      setLastError(null);

      // Test connection before attempting signin
      const isConnected = await testConnection();
      if (!isConnected) {
        throw handleError(new Error('Unable to connect to authentication service'), 'testing connection');
      }

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        throw handleError(error, 'signing in');
      }

      if (rememberMe) {
        localStorage.setItem(REMEMBER_ME_KEY, 'true');
      } else {
        localStorage.removeItem(REMEMBER_ME_KEY);
      }

      setLoading(false);
    } catch (error) {
      setLoading(false);
      if (error instanceof Error) {
        throw error;
      }
      throw handleError(error, 'signing in');
    }
  };

  const signOut = async () => {
    try {
      setLoading(true);
      setLastError(null);

      const { error } = await supabase.auth.signOut();
      if (error) {
        throw handleError(error, 'signing out');
      }
      
      localStorage.removeItem(REMEMBER_ME_KEY);
      setUser(null);
      setLoading(false);
    } catch (error) {
      setLoading(false);
      if (error instanceof Error) {
        throw error;
      }
      throw handleError(error, 'signing out');
    }
  };

  const resetPassword = async (email: string) => {
    try {
      setIsResettingPassword(true);
      setResetPasswordError(null);
      setLastError(null);

      // Test connection before attempting reset
      const isConnected = await testConnection();
      if (!isConnected) {
        throw handleError(new Error('Unable to connect to authentication service'), 'testing connection');
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (error) {
        throw handleError(error, 'requesting password reset');
      }

      setIsResettingPassword(false);
    } catch (error) {
      setIsResettingPassword(false);
      const enhancedError = error instanceof Error ? error : handleError(error, 'requesting password reset');
      setResetPasswordError(enhancedError.message);
      throw enhancedError;
    }
  };

  const updatePassword = async (password: string) => {
    try {
      setLoading(true);
      setLastError(null);

      const { error } = await supabase.auth.updateUser({
        password: password
      });

      if (error) {
        throw handleError(error, 'updating password');
      }

      setLoading(false);
    } catch (error) {
      setLoading(false);
      if (error instanceof Error) {
        throw error;
      }
      throw handleError(error, 'updating password');
    }
  };

  return {
    user,
    loading,
    signIn,
    signUp,
    signOut,
    resetPassword,
    updatePassword,
    isResettingPassword,
    resetPasswordError,
    connectionStatus,
    lastError,
  };
};