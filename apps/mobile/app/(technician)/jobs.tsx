import { router } from 'expo-router';
import { JobCard, type JobSummary } from '@/components/JobCard';
import { ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { useApi } from '@/lib/useApi';

export default function TechnicianJobs() {
  const { data, error, loading } = useApi<{ jobs: JobSummary[] }>('/jobs');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.jobs.length === 0 && <Muted>Jobs you win will appear here.</Muted>}
      {data?.jobs.map((j) => <JobCard key={j.id} job={j} onPress={() => router.push(`/job/${j.id}`)} />)}
    </Screen>
  );
}
