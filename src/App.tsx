import React, { useState } from 'react';
import UploadArea from './UploadArea';
import Preview from './Preview';
import { ConversionResponse, DebugArtifacts, MLStatus, SerializedFloorPlan, UploadResponse } from './shared/types';
import './App.css';

interface ConversionState {
    status: 'idle' | 'uploading' | 'converting' | 'complete' | 'error';
    fileId?: string;
    floorPlanData?: SerializedFloorPlan;
    mlStatus?: MLStatus;
    debugArtifacts?: DebugArtifacts;
    error?: string;
}

const API_BASE_URL = process.env.REACT_APP_API_URL
    || (window.location.hostname === 'localhost' ? 'http://localhost:5001' : '');

const apiUrl = (path: string): string => `${API_BASE_URL}${path}`;

const readApiResponse = async <T,>(response: Response, action: string): Promise<T> => {
    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
        const responseText = await response.text();
        const looksLikeHtml = responseText.trimStart().startsWith('<');
        throw new Error(
            looksLikeHtml
                ? `${action} failed because the API returned HTML instead of JSON. Make sure the backend is running on http://localhost:5001 and start the app with \`npm run dev\`.`
                : `${action} failed because the API returned an unexpected response.`,
        );
    }

    const data = await response.json() as T & { error?: string; success?: boolean };
    if (!response.ok) {
        throw new Error(data.error || `${action} failed`);
    }

    return data as T;
};

function App() {
    const [state, setState] = useState<ConversionState>({ status: 'idle' });

    const handleFileUpload = async (file: File) => {
        setState({ status: 'uploading' });

        try {
            const formData = new FormData();
            formData.append('file', file);

            const uploadRes = await fetch(apiUrl('/api/upload'), {
                method: 'POST',
                body: formData,
            });

            const uploadData = await readApiResponse<UploadResponse>(uploadRes, 'Upload');

            if (!uploadData.success) {
                throw new Error(uploadData.error || 'Upload failed');
            }

            setState({ status: 'converting', fileId: uploadData.fileId });

            const conversionRes = await fetch(apiUrl('/api/convert'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId: uploadData.fileId }),
            });

            const conversionData = await readApiResponse<ConversionResponse>(conversionRes, 'Conversion');

            if (!conversionData.success) {
                throw new Error(conversionData.error || 'Conversion failed');
            }

            setState({
                status: 'complete',
                fileId: uploadData.fileId,
                floorPlanData: conversionData.data,
                mlStatus: conversionData.mlStatus,
                debugArtifacts: conversionData.debugArtifacts,
            });
        } catch (error) {
            setState({
                status: 'error',
                error: error instanceof Error ? error.message : 'An error occurred',
            });
        }
    };

    const handleDownload = () => {
        if (state.fileId) {
            window.location.href = apiUrl(`/api/download/${state.fileId}`);
        }
    };

    return (
        <div className="App">
            <header className="header">
                <h1>Floor2CAD</h1>
                <p>Convert floor plans to DXF files</p>
            </header>

            <main className="container">
                {state.status === 'idle' && (
                    <UploadArea onUpload={handleFileUpload} />
                )}

                {state.status === 'uploading' && (
                    <div className="status">Uploading file...</div>
                )}

                {state.status === 'converting' && (
                    <div className="status">Converting floor plan...</div>
                )}

                {state.status === 'complete' && state.floorPlanData && (
                    <Preview
                        data={state.floorPlanData}
                        mlStatus={state.mlStatus}
                        debugArtifacts={state.debugArtifacts}
                        onDownload={handleDownload}
                    />
                )}

                {state.status === 'error' && (
                    <div className="error">
                        <p>Error: {state.error}</p>
                        <button onClick={() => setState({ status: 'idle' })}>
                            Try Again
                        </button>
                    </div>
                )}
            </main>
        </div>
    );
}

export default App;
