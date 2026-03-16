import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import { User, UserRole } from './types';
import { TRANSLATIONS } from './constants';
import { Shield, Users, Briefcase, Monitor, Lock, User as UserIcon, Loader2, Globe } from 'lucide-react';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState('');
  const [language, setLanguage] = useState<'en' | 'vi' | 'zh'>((localStorage.getItem('aceso_lang') as any) || 'vi');

  const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

  useEffect(() => {
    const savedUser = localStorage.getItem('aceso_user');
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch (e) {
        localStorage.removeItem('aceso_user');
      }
    }
    setIsAuthReady(true);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setError('');
    try {
      const res = await fetch('/api/app?handler=users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'login',
          username: loginData.username,
          password: loginData.password
        })
      });
      const data = await res.json();
      if (data.success) {
        setUser(data.user);
        localStorage.setItem('aceso_user', JSON.stringify(data.user));
      } else {
        setError(data.error || "Login failed");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('aceso_user');
  };

  if (!isAuthReady) return null;

  if (!user) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center p-4 font-sans selection:bg-primary/30">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
        </div>

        <div className="w-full max-w-md relative">
          <div className="absolute -top-12 right-0 flex items-center gap-2">
            <button 
              onClick={() => {
                const next: any = language === 'vi' ? 'en' : language === 'en' ? 'zh' : 'vi';
                setLanguage(next);
                localStorage.setItem('aceso_lang', next);
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-white hover:bg-white/10 transition-all"
            >
              <Globe size={12} /> {language}
            </button>
          </div>

          <div className="bg-white/[0.03] backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-10 shadow-2xl space-y-8">
            <div className="text-center space-y-3">
              <div className="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center mx-auto border border-primary/20 shadow-lg shadow-primary/10 group hover:scale-110 transition-transform duration-500">
                <Shield className="text-primary group-hover:rotate-12 transition-transform" size={40} />
              </div>
              <h1 className="text-3xl font-black text-white uppercase tracking-tighter leading-none pt-4">
                {t.loginTitle}
              </h1>
              <p className="text-xs text-white/40 font-medium uppercase tracking-widest">
                {t.loginDesc}
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-6">
              <div className="space-y-4">
                <div className="relative group">
                  <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-primary transition-colors" size={18} />
                  <input 
                    type="text"
                    placeholder={t.username}
                    value={loginData.username}
                    onChange={e => setLoginData({...loginData, username: e.target.value})}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl pl-12 pr-4 py-4 text-sm text-white placeholder:text-white/20 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
                    required
                  />
                </div>
                <div className="relative group">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30 group-focus-within:text-primary transition-colors" size={18} />
                  <input 
                    type="password"
                    placeholder={t.password}
                    value={loginData.password}
                    onChange={e => setLoginData({...loginData, password: e.target.value})}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl pl-12 pr-4 py-4 text-sm text-white placeholder:text-white/20 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all"
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] font-bold uppercase tracking-wider text-center animate-shake">
                  {error}
                </div>
              )}

              <button 
                type="submit"
                disabled={isLoggingIn}
                className="w-full py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-[0.2em] shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100 transition-all flex items-center justify-center gap-3"
              >
                {isLoggingIn ? <Loader2 className="animate-spin" size={18} /> : <Shield size={18} />}
                {t.loginBtn}
              </button>
            </form>

            <div className="pt-4 border-t border-white/5 grid grid-cols-4 gap-2">
              <RoleIcon icon={<Shield size={14} />} label="Root" />
              <RoleIcon icon={<Monitor size={14} />} label="IT" />
              <RoleIcon icon={<Briefcase size={14} />} label="HR" />
              <RoleIcon icon={<Users size={14} />} label="User" />
            </div>
          </div>
          
          <p className="text-center mt-8 text-[10px] text-white/20 font-black uppercase tracking-[0.3em]">
            &copy; 2026 Aceso Internal Systems
          </p>
        </div>
      </div>
    );
  }

  return (
    <Dashboard user={user} onLogout={handleLogout} />
  );
};

const RoleIcon = ({ icon, label }: { icon: React.ReactNode, label: string }) => (
  <div className="flex flex-col items-center gap-2 opacity-20 hover:opacity-100 transition-opacity cursor-help group">
    <div className="p-2 rounded-lg bg-white/5 border border-white/10 group-hover:border-primary/30 group-hover:bg-primary/10 text-white transition-all">
      {icon}
    </div>
    <span className="text-[8px] font-black uppercase tracking-tighter text-white/40 group-hover:text-primary transition-colors">{label}</span>
  </div>
);

export default App;
