import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './pages.css';
import './responsive.css';
import './media.css';
import './editing.css';
import './tracks.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { message: string }> {
  state = { message: '' };
  static getDerivedStateFromError(error: Error) { return { message: error.message }; }
  render() {
    return this.state.message ? <div className="fatal"><h1>页面暂时无法显示</h1><p>{this.state.message}</p><button onClick={() => window.location.reload()}>重新加载</button></div> : this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
