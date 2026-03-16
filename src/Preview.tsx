import React from 'react';
import { DebugArtifacts, MLFeatureStatus, MLStatus, SerializedFloorPlan } from './shared/types';
import './Preview.css';

interface PreviewProps {
    data: SerializedFloorPlan;
    mlStatus?: MLStatus;
    debugArtifacts?: DebugArtifacts;
    onDownload: () => void;
}

function featureLabel(feature?: MLFeatureStatus): string {
    if (!feature?.configured) {
        return 'Not configured';
    }

    if (!feature.available) {
        return 'Fallback';
    }

    return feature.used ? 'Used in run' : 'Ready';
}

function Preview({ data, mlStatus, debugArtifacts, onDownload }: PreviewProps) {
    const scaleLabel = data.unit === 'px'
        ? 'Uncalibrated'
        : `${data.scale.toFixed(4)} ${data.unit}/px`;

    return (
        <div className="preview-container">
            <h2>Floor Plan Analysis</h2>

            <div className="stats-grid">
                <div className="stat-card">
                    <h3>Walls</h3>
                    <p className="stat-number">{data.walls?.length || 0}</p>
                </div>

                <div className="stat-card">
                    <h3>Openings</h3>
                    <p className="stat-number">{data.openings?.length || 0}</p>
                </div>

                <div className="stat-card">
                    <h3>Furniture</h3>
                    <p className="stat-number">{data.furniture?.length || 0}</p>
                </div>

                <div className="stat-card">
                    <h3>Dimensions</h3>
                    <p className="stat-number">{data.dimensions?.length || 0}</p>
                </div>

                <div className="stat-card">
                    <h3>Texts</h3>
                    <p className="stat-number">{data.textElements?.length || 0}</p>
                </div>

                <div className="stat-card">
                    <h3>Rooms</h3>
                    <p className="stat-number">{data.rooms?.length || 0}</p>
                </div>
            </div>

            <div className="floor-plan-info">
                <p>
                    <strong>Floor Plan Size:</strong> {data.width} x {data.height}px
                </p>
                <p>
                    <strong>Scale:</strong> {scaleLabel}
                </p>
                <p>
                    <strong>Wall confidence:</strong> {(data.metrics?.wallConfidence || 0).toFixed(2)}
                </p>
                <p>
                    <strong>Text confidence:</strong> {(data.metrics?.textConfidence || 0).toFixed(2)}
                </p>
                <p>
                    <strong>Total wall length:</strong> {(data.metrics?.totalWallLength || 0).toFixed(1)} px
                </p>
                <p>
                    <strong>Average wall thickness:</strong> {(data.metrics?.averageWallThickness || 0).toFixed(1)} px
                </p>
                <p>
                    <strong>Junctions:</strong> {data.metrics?.junctionCount || 0}
                </p>
            </div>

            {mlStatus && (
                <div className="ml-status-panel">
                    <h3>ML Assist</h3>
                    <p>
                        <strong>Service:</strong> {mlStatus.reachable ? 'Online' : 'Offline'}
                    </p>
                    <p>
                        <strong>OCR:</strong> {featureLabel(mlStatus.ocr)}
                    </p>
                    <p>
                        <strong>Symbols:</strong> {featureLabel(mlStatus.symbols)}
                    </p>
                    <p>
                        <strong>Segmentation:</strong> {featureLabel(mlStatus.segmentation)}
                    </p>
                    {debugArtifacts && (
                        <p className="debug-paths">
                            <strong>Debug:</strong> {debugArtifacts.directory}
                        </p>
                    )}
                </div>
            )}

            <button className="download-button" onClick={onDownload}>
                📥 Download DXF File
            </button>

            <button
                className="reset-button"
                onClick={() => window.location.reload()}
            >
                Convert Another
            </button>
        </div>
    );
}

export default Preview;
