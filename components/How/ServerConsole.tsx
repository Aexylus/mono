import React from 'react';
import styles from './ServerConsole.module.css';

export default class ServerConsole extends React.Component {
  render() {
    return (
      <div className={styles.serverConsole}>
        <h4 className={styles.panelLabel}>Server Console</h4>
        <div className={styles.consoleOutput}>
          <p className={styles.consoleItem}>Initializing Reflect server</p>
          <p className={styles.consoleItem}>
            Running mutation 1 from client1 on client: 0 → 1
          </p>
          <p className={styles.consoleItem}>
            Got change of key “foo” on client “c1”: 0 → 1
          </p>
          <p className={styles.consoleItem}>
            Running mutation 1 from client1 on server: 0 → 1
          </p>
          <p className={styles.consoleItem}>
            Got change of key “foo” on client “c2”: 0 → 1
          </p>
        </div>
      </div>
    );
  }
}
