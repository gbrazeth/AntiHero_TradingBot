'use client';

import { useState, useEffect, useCallback } from 'react';
import { Activity, Wallet, RefreshCw, BarChart2, ShieldAlert } from 'lucide-react';

interface PositionData {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: string;
  avgPrice: string;
  unrealisedPnl: string;
  stopLoss: string;
}

interface BalanceData {
  coin: string;
  equity: string;
  availableBalance: string;
}

interface HistoryPosition {
  id: number;
  symbol: string;
  side: string;
  entryPrice: number;
  qty: number;
  currentQty: number;
  slPrice: number | null;
  beApplied: boolean;
  status: string;
  realizedPnl: number | null;
  createdAt: string;
  updatedAt: string;
}

export default function Dashboard() {
  const [position, setPosition] = useState<PositionData | 'FLAT' | null>(null);
  const [balance, setBalance] = useState<BalanceData[]>([]);
  const [history, setHistory] = useState<HistoryPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    try {
      setRefreshing(true);
      
      // Fetch Position
      try {
        const posRes = await fetch('http://localhost:3333/status/position');
        if (!posRes.ok) {
          const detail = await posRes.json().catch(() => ({}));
          throw new Error(detail.message || 'Failed to fetch position');
        }
        const posData = await posRes.json();
        setPosition(posData.position === 'FLAT' ? 'FLAT' : posData.position);
      } catch (err) {
        console.error('Position fetch error:', err);
        // Do not re-throw here so the balance fetch can still run
      }

      // Fetch Balance
      try {
        const balRes = await fetch('http://localhost:3333/status/balance');
        if (!balRes.ok) {
           throw new Error('Failed to fetch balance');
        }
        const balData = await balRes.json();
        setBalance(balData.balance);
      } catch (err) {
        console.error('Balance fetch error:', err);
      }
      
      // Fetch History
      try {
        const histRes = await fetch('http://localhost:3333/status/history');
        if (histRes.ok) {
          const histData = await histRes.json();
          setHistory(histData.history || []);
        }
      } catch (err) {
        console.error('History fetch error:', err);
      }
      
      setError(null);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Auto refresh every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  const usdtBalance = balance.find(b => b.coin === 'USDT');

  return (
    <div className="dashboard-container">
      <header className="header">
        <div className="header-title">
          <Activity color="var(--accent-color)" size={32} />
          <h1>AntiHero Trading Bot Dashboard</h1>
        </div>
        
        <div className="header-actions">
          <div className="status-badge">
            <div className={`status-dot ${error ? 'offline' : 'online'}`}></div>
            {error ? 'API Offline' : 'API Online'}
          </div>
          
          <button 
            className={`refresh-button ${refreshing ? 'spinning' : ''}`}
            onClick={fetchData}
            title="Refresh Data"
          >
            <RefreshCw size={20} />
          </button>
        </div>
      </header>

      {error && (
        <div className="card card-error">
          <div className="card-header text-danger">
            <ShieldAlert size={20} />
            <span className="card-title">Connection Error</span>
          </div>
          <p>{error}</p>
          <p className="stat-label card-error-hint">
            Make sure the bot backend (localhost:3333) is running.
          </p>
        </div>
      )}

      <div className="grid">
        {/* WALLET CARD */}
        <div className="card">
          <div className="card-header">
            <Wallet size={20} className="text-accent" />
            <span className="card-title">Wallet Balance</span>
          </div>
          
          {loading ? (
            <>
              <div className="skeleton skeleton-title"></div>
              <div className="skeleton skeleton-text"></div>
            </>
          ) : (
            <>
              <div className="main-stat">
                <span className="stat-value">{usdtBalance ? parseFloat(usdtBalance.equity).toFixed(2) : '0.00'}</span>
                <span className="currency">USDT</span>
              </div>
              <span className="stat-label">Total Equity (Testnet)</span>
              
              <div className="wallet-details">
                <div className="info-row">
                  <span className="info-label">Available Balance</span>
                  <span className="info-value">{usdtBalance ? parseFloat(usdtBalance.availableBalance).toFixed(2) : '0.00'} USDT</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* POSITION CARD */}
        <div className="card">
          <div className="card-header">
            <BarChart2 size={20} className={position === 'FLAT' ? 'text-secondary' : 'text-success'} />
            <span className="card-title">Current Position</span>
          </div>

          {loading ? (
            <>
              <div className="skeleton skeleton-title"></div>
              <div className="skeleton skeleton-text"></div>
              <div className="skeleton skeleton-text wallet-details"></div>
            </>
          ) : position === 'FLAT' || !position ? (
            <div className="position-empty">
              <div className="badge flat badge-inline">
                FLAT / NO POSITION
              </div>
              <span className="stat-label">Waiting for TradingView signals...</span>
            </div>
          ) : (
            <>
              <div className="position-header">
                <div>
                  <div className="stat-value position-symbol">{position.symbol}</div>
                  <span className="stat-label">Perpetual Contract</span>
                </div>
                <div className={`badge ${position.side === 'Buy' ? 'long' : 'short'}`}>
                  {position.side === 'Buy' ? 'LONG' : 'SHORT'}
                </div>
              </div>

              <div className="info-row">
                <span className="info-label">Entry Price</span>
                <span className="info-value text-accent">${parseFloat(position.avgPrice).toFixed(2)}</span>
              </div>
              
              <div className="info-row">
                <span className="info-label">Size</span>
                <span className="info-value">{position.size} {position.symbol.replace('USDT', '')}</span>
              </div>

              <div className="info-row">
                <span className="info-label">Stop Loss</span>
                <span className="info-value">{position.stopLoss ? `$${parseFloat(position.stopLoss).toFixed(2)}` : 'N/A'}</span>
              </div>

              <div className="info-row position-pnl-row">
                <span className="info-label">Unrealized PNL</span>
                <span className={`info-value ${parseFloat(position.unrealisedPnl) >= 0 ? 'text-success' : 'text-danger'}`}>
                  {parseFloat(position.unrealisedPnl) > 0 ? '+' : ''}{position.unrealisedPnl}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* HISTORY CARD */}
      <div className="card mt-6">
        <div className="card-header">
          <Activity size={20} className="text-secondary" />
          <span className="card-title">Recent Transactions</span>
        </div>
        
        {loading ? (
          <div className="skeleton skeleton-text history-skeleton"></div>
        ) : history.length === 0 ? (
          <div className="position-empty history-empty">
            <span className="stat-label">No transaction history yet.</span>
          </div>
        ) : (
          <div className="history-table-container">
            <table className="history-table">
              <thead>
                <tr className="history-thead-tr">
                  <th className="history-th">Started On</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Entry Price</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Realized PNL</th>
                </tr>
              </thead>
              <tbody>
                {history.map((pos) => (
                  <tr key={pos.id} className="history-tr">
                    <td className="history-td">
                      {new Date(pos.createdAt).toLocaleString()}
                    </td>
                    <td><span className="stat-value text-small">{pos.symbol}</span></td>
                    <td>
                      <span className={`badge badge-sm ${pos.side === 'BUY' ? 'long' : 'short'}`}>
                        {pos.side === 'BUY' ? 'LONG' : 'SHORT'}
                      </span>
                    </td>
                    <td>${Number(pos.entryPrice).toFixed(2)}</td>
                    <td>{pos.qty}</td>
                    <td className="capitalize">
                      <span className={pos.status === 'open' ? 'text-success' : 'text-secondary'}>
                        {pos.status}
                      </span>
                    </td>
                    <td className={`font-bold ${pos.realizedPnl ? (pos.realizedPnl > 0 ? 'text-success' : 'text-danger') : ''}`}>
                      {pos.status === 'open' ? 'Live on Chart' : (pos.realizedPnl ? `${pos.realizedPnl > 0 ? '+' : ''}$${Number(pos.realizedPnl).toFixed(2)}` : '$0.00')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      
      <div className="footer-timestamp">
        <span className="stat-label" suppressHydrationWarning>
          {loading ? 'Consultando API...' : `Last updated: ${lastUpdate.toLocaleTimeString()}`}
        </span>
      </div>
    </div>
  );
}
